import type { Dispatch } from "react";
import type { Action, ChatMessage, InventionDraftState } from "./model.ts";
import { extractFacts } from "./model.ts";
import { chatWithModel, extractAny, searchAny } from "./provider-api.ts";
import { runDraftTurn } from "./draft-run.ts";
import { runReviseTurn } from "./draft-revise.ts";
import { runAutoPatent } from "./auto-flow.ts";
import { groundFacts, parseSkillReply } from "./patent-skill.ts";
import { CREATE_TRACE_PREFIX, OUTLINE_MATERIAL_NAME, buildChatMessages, conversationMaterial, draftExtra, materialsText, type PackedMaterial, type SlashIntent } from "./skill-turn.ts";
import { citedSources, streamAgent } from "./agent-stream.ts";
import { TOOL_LABEL, type AgentEvent, type AgentSource } from "./agent-events.ts";

/** Intents allowed to reach the web. Digging points, drafting and reading stay inside the user's own materials. */
export function intentUsesTools(intent: SlashIntent): boolean {
  return intent === "search" || intent === "chart" || intent === "chat" || intent === "create";
}

interface ModelReply {
  ok: boolean;
  text: string;
  detail: string;
  model: string;
  sources: AgentSource[];
  aborted: boolean;
}

/** Turn agent events into trace lines the chat shows while the turn runs. Deltas are not shown: the reply is structured and parsed at the end. */
export function traceForEvent(event: AgentEvent): string | null {
  if (event.type === "tool_call") {
    const label = TOOL_LABEL[event.name] || event.name;
    const target = typeof event.input.query === "string" ? `「${event.input.query}」` : typeof event.input.url === "string" ? event.input.url : "";
    return `${label}${target ? `：${target}` : ""}`;
  }
  if (event.type === "tool_result") {
    const label = TOOL_LABEL[event.name] || event.name;
    return `${label}${event.ok ? "完成" : "没有成功"}：${event.summary}`;
  }
  if (event.type === "notice") return event.detail;
  return null;
}

export function sourcesTrace(sources: AgentSource[]): string {
  const lines = sources.slice(0, 8).map((source) => `[${source.n}] ${source.title || source.url} ${source.url}`.trim());
  return `本轮引用的网络线索：${lines.join("；")}。这些是检索线索，不是已核验的对比文件。`;
}

async function askModel(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  intent: SlashIntent,
  onTrace: (text: string) => void,
  signal?: AbortSignal,
): Promise<ModelReply> {
  const tools = intentUsesTools(intent);
  const outcome = await streamAgent(
    {
      messages,
      tools,
      // 一句话创作要换角度检索专利、论文和行业痛点，给它更多步数；大纲和候选题目都比普通对话长。
      maxSteps: tools ? (intent === "create" ? 8 : 4) : 1,
      // 一句话创作要查专利、论文和行业痛点，给 6 次检索；其余意图 4 次。
      maxSearches: intent === "create" ? 6 : 4,
      ...(intent === "draft" || intent === "revise" ? { maxTokens: 24000 } : intent === "outline" || intent === "create" ? { maxTokens: 6000 } : {}),
    },
    (event) => {
      const line = traceForEvent(event);
      if (line) onTrace(line);
    },
    signal,
  );
  if (outcome.type === "done") {
    return { ok: Boolean(outcome.text.trim()), text: outcome.text, detail: outcome.text.trim() ? "" : "模型返回了空回答", model: outcome.model, sources: outcome.sources, aborted: false };
  }
  if (signal?.aborted) return { ok: false, text: "", detail: "已停止", model: "", sources: [], aborted: true };
  // An older server without /api/agent: fall back to the plain chat route once.
  if (outcome.status === 404) {
    const plain = await chatWithModel(messages, signal);
    return { ...plain, sources: [], aborted: Boolean(signal?.aborted) };
  }
  return { ok: false, text: "", detail: outcome.detail, model: "", sources: outcome.sources ?? [], aborted: false };
}

export async function runPatentTurn(input: {
  caseId: string;
  material?: string;
  fileName?: string;
  materials?: PackedMaterial[];
  history?: ChatMessage[];
  intent?: SlashIntent;
  pursued?: string[];
  /** 案件里已有的候选题目（全自动成稿沿用，不重新选题）。 */
  ideas?: Array<{ title: string; problem?: string; feature?: string; effect?: string; pending?: string; status?: string }>;
  facts?: string[];
  chosenPoint?: { title: string; problem?: string; feature?: string; effect?: string };
  /** 当前的申请文件（/修改 和成稿后的自然语言修改要求用）。 */
  draft?: InventionDraftState | null;
  userText: string;
  displayText?: string;
  recordUser: boolean;
  attachments?: Array<{ name: string; kind: "pdf" | "text"; chars: number; pages?: number }>;
  dispatch: Dispatch<Action>;
  signal?: AbortSignal;
}): Promise<void> {
  const materials = input.materials?.length
    ? input.materials
    : input.material
      ? [{ name: input.fileName || "材料.md", kind: /\.pdf$/i.test(input.fileName || "") ? "pdf" as const : "text" as const, text: input.material }]
      : [];
  const corpus = materialsText(materials);
  const intent = input.intent || "chat";
  const trace = (text: string) => input.dispatch({ type: "chat-note", caseId: input.caseId, role: "trace", text });
  if (input.recordUser) {
    input.dispatch({
      type: "chat-note",
      caseId: input.caseId,
      role: "user",
      text: input.displayText ?? input.userText,
      attachments: input.attachments,
    });
  }
  // “不要问我，直接做”：选题 → 大纲 → 完整申请文件一次跑完，不停下来等发明人。
  if (intent === "auto") {
    await runAutoPatent(
      {
        caseId: input.caseId,
        userText: input.userText,
        history: input.history,
        materials,
        ideas: input.ideas,
        facts: input.facts,
        dispatch: input.dispatch,
        signal: input.signal,
      },
      {
        ask: (messages, stepIntent, onTrace, signal) => askModel(messages, stepIntent, onTrace, signal),
        draft: {
          ask: (messages, onTrace, signal) => askModel(messages, "draft", onTrace, signal),
          search: (query) => searchAny(query, "cn"),
          extract: (url) => extractAny(url),
        },
      },
    );
    return;
  }
  // 成稿后的修改：只对已有申请文件做定点修改，套用后重新自检和形式核查，不达标保留原稿。
  if (intent === "revise") {
    await runReviseTurn(
      { caseId: input.caseId, draft: input.draft, instruction: input.userText, dispatch: input.dispatch, signal: input.signal },
      { ask: (messages, onTrace, signal) => askModel(messages, "revise", onTrace, signal) },
    );
    return;
  }
  // A description typed into the chat is the inventor's own source text, so /发明稿 may draft from it even
  // when nothing was attached. Assistant replies and trace lines never count as material.
  const fromChat = intent === "draft" ? conversationMaterial(input.history ?? [], corpus) : null;
  // Whatever the inventor typed after /发明稿 is source text too: one sentence is enough to start a full draft.
  const typed = intent === "draft" ? draftExtra(input.userText) : "";
  const withChat = fromChat ? [...materials, fromChat] : materials;
  const draftMaterials: PackedMaterial[] = typed && !materialsText(withChat).includes(typed) ? [...withChat, { name: "本轮描述.md", kind: "text", text: typed }] : withChat;
  if (intent === "draft" && (materialsText(draftMaterials).replace(/\s/g, "").length >= 6 || (input.facts?.length ?? 0) > 0)) {
    await runDraftTurn(
      {
        caseId: input.caseId,
        materials: draftMaterials,
        userText: input.userText,
        facts: input.facts,
        pursued: input.pursued,
        chosenPoint: input.chosenPoint,
        dispatch: input.dispatch,
        signal: input.signal,
      },
      {
        ask: (messages, onTrace, signal) => askModel(messages, "draft", onTrace, signal),
        search: (query) => searchAny(query, "cn"),
        extract: (url) => extractAny(url),
        expand: true,
      },
    );
    return;
  }
  trace(traceLine(intent, materials.map((item) => item.name)));
  const result = await askModel(
    buildChatMessages({
      materials,
      history: input.history ?? [],
      userText: input.userText,
      intent,
      pursued: input.pursued,
      memory: input.facts,
      tools: intentUsesTools(intent),
    }),
    intent,
    trace,
    input.signal,
  );
  if (input.signal?.aborted || result.aborted) {
    input.dispatch({ type: "chat-note", caseId: input.caseId, role: "assistant", text: "已停止这一轮。" });
    return;
  }
  if (!result.ok || !result.text) {
    if (intent !== "read" && corpus.length >= 40) {
      const local = extractFacts(corpus, materials[0]?.name || "材料").map((fact) => ({
        statement: fact.statement,
        kind: fact.kind,
        origin: fact.origin === "inventor" ? "source" as const : fact.origin,
      }));
      input.dispatch({ type: "merge-facts", caseId: input.caseId, sourceLabel: materials[0]?.name || "材料", facts: local });
    }
    input.dispatch({
      type: "chat-note",
      caseId: input.caseId,
      role: "assistant",
      text: `当前模型没有完成这一步（${result.detail}）。${
        intent === "read"
          ? "未更改案件事实、候选点或申请文件；请稍后重试解读。"
          : corpus.length >= 40
          ? "已改用本地规则整理事实，来源和推断仍然分开。"
          : /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(String(result.detail ?? ""))
            ? "连不上模型接口：请在「设置」里检查接口地址和网络，或换一个已配置密钥的模型，然后再发一句。"
            : "你可以再发一句，或在「设置」里换一个已配置密钥的模型。"
      }`,
    });
    return;
  }
  const parsed = parseSkillReply(result.text);
  // Read-only is enforced here, not just in the prompt. Even an unexpected
  // metadata block cannot rename the case, add facts/ideas or trigger search.
  if (intent === "read") {
    input.dispatch({ type: "chat-note", caseId: input.caseId, role: "assistant", text: parsed.reply });
    return;
  }
  const facts = groundFacts(parsed.facts, corpus);
  if (parsed.title) input.dispatch({ type: "rename-case", caseId: input.caseId, title: parsed.title });
  if (facts.length > 0) input.dispatch({ type: "merge-facts", caseId: input.caseId, sourceLabel: result.model || materials[0]?.name || "模型", facts });
  if (parsed.patentPoints.length > 0) {
    input.dispatch({
      type: "merge-ideas",
      caseId: input.caseId,
      ideas: parsed.patentPoints,
    });
  }
  input.dispatch({ type: "chat-note", caseId: input.caseId, role: "assistant", text: parsed.reply });
  if (intent === "create" && parsed.patentPoints.length > 0) {
    trace(`已列出 ${parsed.patentPoints.length} 个候选题目。在候选卡片上选定一个，我会按它设计大纲目录；大纲确认后再写完整申请文件。`);
  }
  if (intent === "outline" && parsed.reply.replace(/\s/g, "").length >= 200) {
    const title = input.chosenPoint?.title || input.pursued?.find((item) => item.trim()) || "选定题目";
    input.dispatch({
      type: "attach-materials",
      caseId: input.caseId,
      materials: [
        {
          name: OUTLINE_MATERIAL_NAME,
          kind: "text",
          text: `【${title}】创作大纲（AI 根据检索线索设计，参数为建议值、效果为预期，需发明人确认）\n\n${parsed.reply}`,
        },
      ],
    });
    trace(`大纲已存为本案材料「${OUTLINE_MATERIAL_NAME}」。可以直接改大纲再发给我；确认后点「按大纲写完整稿」或发送 /发明稿，生成全部申请文件。`);
  }
  if (result.sources.length > 0) {
    const cited = citedSources(parsed.reply || result.text, result.sources);
    trace(sourcesTrace(cited));
    if (intent === "search" || intent === "chart") {
      input.dispatch({
        type: "add-knowledge",
        name: `检索线索 ${new Date().toISOString().slice(0, 10)}`,
        kind: "text",
        text: [
          "以下为 Agent 联网检索得到的线索，尚未核验，不能直接作为对比文件。",
          ...cited.map((source) => `[${source.n}] ${source.title || "未命名"}\n${source.url}`),
        ].join("\n\n"),
      });
    }
    // The agent already searched this turn; do not spend a second search on the same question.
    return;
  }
  const query = parsed.searchQueries.find((item) => item.length >= 2 && item.length <= 80);
  if (!query || intent === "ideas" || intent === "chat") return;
  const found = await searchAny(query);
  if (input.signal?.aborted) return;
  const lines = found.results.slice(0, 3).map((item) => `${item.title} ${item.url}`.trim());
  trace(
    lines.length
      ? `查新检索式「${query}」。AnySearch 线索：${lines.join("；")}。这些不是已核验对比文件。`
      : `查新检索式「${query}」。${found.detail}`,
  );
}

function traceLine(intent: SlashIntent, names: string[]): string {
  const files = names.length ? `已读取 ${names.map((name) => `《${name}》`).join("、")}。` : "这一轮还没有新附件。";
  if (intent === "create") return `${CREATE_TRACE_PREFIX}：联网检索该领域的专利和论文 → 归纳现有做法和缺陷 → 给出候选题目让你选。${files}`;
  if (intent === "outline") return `专利技能：设计大纲。按选定题目写技术方案、权利要求布局、附图清单和实施例安排，参数为建议值。${files}`;
  if (intent === "ideas") return `专利技能：对话挖点。${files}不抓取官网，也不编造实验。`;
  if (intent === "search") return `专利技能：查新检索，可联网。${files}`;
  if (intent === "read") return `专利技能：解读附件。${files}`;
  if (intent === "chart") return `专利技能：特征对照，可联网补线索。${files}`;
  if (intent === "draft") return `专利技能：发明稿（材料还不够，先补事实）。${files}`;
  if (intent === "disclosure") return `专利技能：收件 → 扫描 → 挖点 → 预览。${files}不联网。`;
  return `专利技能：继续对话。${files}`;
}
