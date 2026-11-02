/**
 * 公式与参数的专项审阅：让模型以“补丁”而不是“重写全文”的方式修正数学问题。
 *
 * 确定性检查（formula-audit）能发现符号冲突、范围矛盾、公式不一致这类形式问题，但发现不了物理意义上的错误：
 * 坐标方向与重力项符号相反、边界条件写反、单位没有换算、系数没有截断到 [0,1]、缺水量没有取非负……
 * 这一轮把全文和确定性检查的结果交给模型，要求它只输出 {find, replace, reason} 形式的定点补丁：
 *   - find 必须逐字摘自原文，且在全文只出现一次（或标明 all 并给出全部出现位置统一替换）；
 *   - 补丁逐条套用，套不上的（找不到、出现多次、会改动章节标题）记为跳过，不做任何猜测性替换；
 *   - 结果可审计：每条补丁的原文、新文和理由都保留下来，写进内部审核单。
 */
import { auditFormulas, draftFormulaSources, formulaIssueLines } from "./formula-audit.ts";
import { escapeLatexBackslashes } from "./json-latex.ts";

export interface MathPatch {
  find: string;
  replace: string;
  reason: string;
  /** 同一段原文在多处出现且都要改（例如统一更换一个符号）时为 true。 */
  all?: boolean;
}

export interface MathReviewReply {
  patches: MathPatch[];
  notes: string[];
}

export interface AppliedPatch extends MathPatch {
  count: number;
}

export interface SkippedPatch extends MathPatch {
  why: string;
}

export interface PatchResult {
  text: string;
  applied: AppliedPatch[];
  skipped: SkippedPatch[];
}

export const MAX_MATH_PATCHES = 40;
const MAX_FIND = 1200;

export const MATH_REVIEW_SYSTEM = `你是同时精通专利撰写和所属技术领域数理模型的资深专利代理师，正在对一份发明专利申请文件草稿做“公式与参数专项审阅”。你只修正数学、物理和参数问题，不改写其他内容。

【逐项检查】
1. 符号约定与方程形式：坐标轴方向、正负号约定与方程一致。例如垂向坐标 z 以向下为正时，Richards 方程应为 ∂θ/∂t = ∂/∂z[K(θ)(∂ψ/∂z − 1)] − S(z,t)；以向上为正时才是 (∂ψ/∂z + 1)。涉及根系吸水、源汇项的方程要写出源汇项。
2. 边界条件与初始条件：与坐标方向一致、物理含义正确。例如自由排水下边界是总水头单位梯度，即 ∂ψ/∂z = 0（z 向下为正时 ∂H/∂z = −1），不是 ∂ψ/∂z = 1；通量边界写明正负号含义。
3. 量纲与单位：同一方程各项单位一致；不同时间或长度单位的量进入同一方程前写明换算（例如 ET₀ 以 mm/d 计，进入以 m、s 为单位的方程前乘以 1/(1000×86400)）；计算结果的单位写明。
4. 取值边界：系数类量（胁迫系数、效率、比例）截断到其物理区间，写成分段函数或 min/max；缺水量、灌水量等不能为负的量写成 max(0, ·)；分母可能为零时写明条件。
5. 上下限关系：目标下限、上限等成对参数在全部参数范围内满足下限 < 上限，公式本身要保证这一点。
6. 求和与离散：求和写明指标和范围（\\sum_{i=1}^{N}）；分层厚度不等时不能写成“等步长 Δz 与各层厚度一致”，要么按非均匀网格写，要么写明计算网格与土层分层的关系。
7. 一个符号一个含义：同一字母不同含义时换用不同符号或下标（例如水分胁迫系数与饱和导水率不能都写成 K_s，可改为 K_w 与 K_sat）；全文统一修改。
8. 数值一致：权利要求中的数值范围必须包含实施例中的数值；各层比例之和为 1 的参数不能每层都限定在一个较高的范围内；示例计算的数值代入公式后结果要算对。
9. 跨章节一致：同一公式在权利要求书、发明内容、具体实施方式、摘要中必须逐字相同。修改一个公式时，必须为它在全文的每一处出现分别给出补丁。
10. 书写规范：公式一律用 LaTeX。行内符号写成 $K_{\\mathrm{sat}}$；独立公式单独成行写成 $$ … $$，说明书中的独立公式在行尾按出现顺序编号“（1）（2）…”，权利要求中的公式不编号；多字母下标用 \\mathrm{}；公式后用“式中，……为……（单位）”逐个说明符号。把普通文字写的公式改成这种写法。

【补丁规则】
- 只输出一个 json 代码块，格式：{"patches":[{"find":"","replace":"","reason":"","all":false}],"notes":[""]}。
- find 必须从草稿原文逐字复制（含标点、空格、换行），在全文只出现一次；为保证唯一，可以带上前后几个字。单条 find 不超过 600 字。
- 同一段原文确实在多处出现且都要同样修改时，写 "all": true。
- replace 是替换后的完整文字，保留 find 中不需要修改的部分。
- 不改动章节标题、权利要求编号和引用关系，不删除整段内容，不新增权利要求。
- 不编造实验数据或测试结果；原有的“（模拟值，待实验验证）”标注保留不动；材料中没有的数值写所属领域常规的取值范围及其确定方法，不新增任何【待……】占位。
- reason 用一句话说明错在哪里、依据是什么。
- 无法通过补丁解决、需要发明人决定的问题写进 notes。
- 没有需要修改的问题时输出 {"patches":[],"notes":[]}。`;

/** True when a draft carries formulas (LaTeX or plain-text equations) worth a dedicated review. */
export function shouldReviewMath(draft: string): boolean {
  return auditFormulas(draftFormulaSources(draft)).applicable;
}

export function buildMathReviewPrompt(draft: string, guide = ""): string {
  const report = auditFormulas(draftFormulaSources(draft));
  const findings = formulaIssueLines(report, 20);
  return [
    "请对下面的发明专利申请文件草稿做公式与参数专项审阅，按系统要求只输出补丁 json。",
    "",
    `【确定性检查已发现的问题】\n${findings.length ? findings.map((line, index) => `${index + 1}. ${line}`).join("\n") : "（未发现形式问题，请重点检查物理意义、符号约定、边界条件和量纲）"}`,
    "",
    ...(guide ? [`【领域撰写指引】\n${guide}`, ""] : []),
    `【草稿全文】\n${draft.length > 60_000 ? `${draft.slice(0, 60_000)}\n（以下省略）` : draft}`,
  ].join("\n");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Parse the reviewer's json reply; anything malformed yields no patches. */
export function parseMathReview(reply: string): MathReviewReply {
  const empty: MathReviewReply = { patches: [], notes: [] };
  if (!reply.trim()) return empty;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  let raw = fenced ? fenced[1] : reply;
  if (!fenced) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return empty;
    raw = raw.slice(start, end + 1);
  }
  let data: unknown;
  try {
    // LaTeX 反斜杠先修正，见 json-latex.ts
    data = JSON.parse(escapeLatexBackslashes(raw.trim()));
  } catch {
    return empty;
  }
  if (!data || typeof data !== "object") return empty;
  const record = data as { patches?: unknown; notes?: unknown };
  const patches = (Array.isArray(record.patches) ? record.patches : [])
    .map((item) => {
      const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return { find: str(row.find), replace: str(row.replace), reason: str(row.reason).trim(), all: row.all === true };
    })
    .filter((patch) => patch.find.trim() && patch.find !== patch.replace)
    .slice(0, MAX_MATH_PATCHES);
  const notes = (Array.isArray(record.notes) ? record.notes : []).map(str).map((note) => note.trim()).filter(Boolean).slice(0, 12);
  return { patches, notes };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function headingCount(text: string): number {
  return (text.match(/^#{1,6}\s/gm) ?? []).length;
}

function claimStarts(text: string): string[] {
  return [...text.matchAll(/^\s*(\d{1,3})\s*[.、．]/gm)].map((hit) => hit[1]);
}

/**
 * Apply patches one by one to the draft body (the trailing json block is never touched). A patch applies only
 * when its find text occurs exactly once (or `all` is set); whitespace differences are tolerated when they still
 * give a single match. Patches that would add or remove headings or renumber claims are refused.
 */
export function applyPatches(draft: string, patches: MathPatch[]): PatchResult {
  const tailMatch = /\n?```json[\s\S]*?```\s*$/i.exec(draft);
  let body = tailMatch ? draft.slice(0, tailMatch.index) : draft;
  const tail = tailMatch ? draft.slice(tailMatch.index) : "";
  const applied: AppliedPatch[] = [];
  const skipped: SkippedPatch[] = [];
  for (const patch of patches.slice(0, MAX_MATH_PATCHES)) {
    if (!patch.find.trim()) {
      skipped.push({ ...patch, why: "原文为空" });
      continue;
    }
    if (patch.find.length > MAX_FIND) {
      skipped.push({ ...patch, why: "原文片段过长" });
      continue;
    }
    if (headingCount(patch.find) !== headingCount(patch.replace)) {
      skipped.push({ ...patch, why: "会增删章节标题" });
      continue;
    }
    if (claimStarts(patch.find).join(",") !== claimStarts(patch.replace).join(",")) {
      skipped.push({ ...patch, why: "会改动权利要求编号" });
      continue;
    }
    let count = body.split(patch.find).length - 1;
    let pattern: RegExp | null = null;
    if (count === 0) {
      const loose = new RegExp(escapeRegExp(patch.find.trim()).replace(/\s+/g, "\\s+"), "g");
      const hits = body.match(loose)?.length ?? 0;
      if (hits > 0) {
        pattern = loose;
        count = hits;
      }
    }
    if (count === 0) {
      skipped.push({ ...patch, why: "原文中找不到这段文字" });
      continue;
    }
    if (count > 1 && !patch.all) {
      skipped.push({ ...patch, why: `这段文字在全文出现 ${count} 次，无法确定改哪一处` });
      continue;
    }
    if (pattern) {
      const replacement = patch.replace;
      body = body.replace(pattern, () => replacement);
    } else {
      body = body.split(patch.find).join(patch.replace);
    }
    applied.push({ ...patch, count });
  }
  return { text: body + tail, applied, skipped };
}

export interface MathReviewRecord {
  /** 补丁是否被采用（套用后形式错误增加或稿件不完整时整体不采用）。 */
  accepted: boolean;
  applied: Array<{ find: string; replace: string; reason: string }>;
  skipped: Array<{ find: string; reason: string; why: string }>;
  notes: string[];
}

export function mathReviewRecord(result: PatchResult, notes: string[], accepted: boolean): MathReviewRecord {
  return {
    accepted,
    applied: result.applied.map((item) => ({ find: item.find, replace: item.replace, reason: item.reason })),
    skipped: result.skipped.map((item) => ({ find: item.find, reason: item.reason, why: item.why })),
    notes,
  };
}

/** Chat-note lines for a finished review; empty when there was no review. */
export function mathReviewNote(record?: MathReviewRecord | null): string {
  if (!record) return "";
  const lines: string[] = [];
  if (record.accepted && record.applied.length) {
    lines.push(`公式与参数专项审阅：修正 ${record.applied.length} 处${record.skipped.length ? `（另有 ${record.skipped.length} 条建议无法唯一定位，未套用）` : ""}：`);
    record.applied.slice(0, 6).forEach((item) => lines.push(`· ${item.reason || "公式修正"}`));
    if (record.applied.length > 6) lines.push(`· 其余 ${record.applied.length - 6} 处见内部审核单`);
  } else if (record.applied.length) {
    lines.push("公式与参数专项审阅给出的修改会带来新的形式问题，已整体放弃，保留原稿。");
  } else {
    lines.push("公式与参数专项审阅：没有需要套用的修改。");
  }
  if (record.notes.length) {
    lines.push("需要你确认的公式与参数问题：");
    record.notes.slice(0, 6).forEach((note, index) => lines.push(`${index + 1}. ${note}`));
  }
  return lines.join("\n");
}
