/**
 * 上下文管理：决定每一轮真正发给模型的内容。
 *   - estimateTokens：中英文混排的 token 粗估（中文约 1 字 1 token，西文约 3.6 字符 1 token）；
 *   - compactDialog：保留最近几轮原文，更早的对话压成一行一条的摘要，避免长会话把上下文挤爆；
 *   - selectMaterial：资料超出预算时按与本轮问题的相关度分块节选，而不是粗暴截掉中段；
 *   - environmentBlock：告诉模型它在什么平台、今天几号、本轮任务、能否联网、手里有哪些资料。
 */

export interface MaterialLike {
  name: string;
  kind: string;
  text: string;
}

export interface DialogTurn {
  role: "user" | "assistant";
  content: string;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let wide = 0;
  let total = 0;
  for (const char of text) {
    total += 1;
    if ((char.codePointAt(0) ?? 0) >= 0x2e80) wide += 1;
  }
  return Math.ceil(wide + (total - wide) / 3.6);
}

function clip(text: string, cap: number): string {
  const value = text.trim();
  if (value.length <= cap) return value;
  const head = Math.max(24, Math.floor(cap * 0.72));
  const tail = Math.max(16, cap - head - 12);
  return `${value.slice(0, head)}\n…[中间省略]…\n${value.slice(-tail)}`;
}

function firstLine(text: string, cap: number): string {
  const line = text.replace(/```[\s\S]*?```/g, " ").split(/\n+/).map((item) => item.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

/** Recent turns verbatim within a token budget; older turns as a one-line-per-turn summary. */
export function compactDialog(
  messages: ReadonlyArray<{ role: string; text: string }>,
  options: { budget?: number; keep?: number; clip?: number } = {},
): { recent: DialogTurn[]; summary: string; dropped: number } {
  const budget = options.budget ?? 9000;
  const keep = options.keep ?? 10;
  const cap = options.clip ?? 1500;
  const turns: DialogTurn[] = messages
    .filter((item) => (item.role === "user" || item.role === "assistant") && item.text.trim())
    .map((item) => ({ role: item.role as "user" | "assistant", content: clip(item.text, cap) }));
  const recent: DialogTurn[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const cost = estimateTokens(turns[index].content);
    if (recent.length >= keep || (recent.length >= 2 && used + cost > budget)) break;
    recent.unshift(turns[index]);
    used += cost;
  }
  // Chat APIs expect the dialog after the system prompt to open with a user turn.
  while (recent.length && recent[0].role === "assistant") recent.shift();
  const older = turns.slice(0, turns.length - recent.length);
  // The first turn usually carries the inventor's fullest description of the invention: always keep it.
  const kept = older.length > 24 ? [older[0], ...older.slice(-23)] : older;
  const summary = kept
    .map((turn) => `${turn.role === "user" ? "发明人" : "助手"}：${firstLine(turn.content, turn.role === "user" ? 140 : 90)}`)
    .filter((line) => !line.endsWith("："))
    .join("\n");
  return { recent, summary, dropped: older.length };
}

const STOP_BIGRAMS = new Set(["一种", "请根", "根据", "发明", "专利", "进行", "以及", "我们", "这个", "可以", "什么", "一下", "帮我", "附件", "材料", "资料", "请把", "如何", "怎么"]);

export function chunkText(text: string, size = 900): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}|\n(?=【)/)) {
    const piece = paragraph.trim();
    if (!piece) continue;
    if (piece.length > size) {
      if (current) chunks.push(current);
      current = "";
      for (let start = 0; start < piece.length; start += size) chunks.push(piece.slice(start, start + size));
      continue;
    }
    if (current && current.length + piece.length + 2 > size) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const run of query.replace(/[^\u4e00-\u9fff]+/g, " ").split(" ").filter(Boolean)) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      const pair = run.slice(index, index + 2);
      if (!STOP_BIGRAMS.has(pair)) terms.add(pair);
    }
  }
  for (const word of query.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? []) {
    const clean = word.replace(/[._-]+$/, "");
    if (clean.length >= 3 && !STOP_WORDS.has(clean)) terms.add(clean);
  }
  return [...terms].slice(0, 80);
}

/** English function words and request boilerplate: they say nothing about which part of a document is wanted. */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "these", "those", "into", "onto", "over", "under", "about", "above", "below",
  "are", "was", "were", "been", "being", "have", "has", "had", "does", "did", "doing", "can", "could", "should", "would", "will",
  "shall", "may", "might", "must", "not", "but", "its", "their", "there", "here", "what", "which", "who", "whom", "whose", "when",
  "where", "why", "how", "all", "any", "each", "some", "such", "than", "then", "also", "only", "very", "more", "most", "other",
  "our", "your", "you", "they", "them", "his", "her", "she", "him", "based", "attached", "attachment", "paper", "document", "file",
  "pdf", "please", "summarize", "summarise", "summary", "explain", "describe", "give", "tell", "list", "show", "write", "make",
  "use", "using", "used", "according", "main", "page", "pages", "number", "numbers", "cite", "citing", "citation", "section",
  "sections", "chapter", "part",
]);

/** Section numbers a question points at: "Section 4", "Sec. 3.2", "§5", "第4节", "第 2 章". */
export function sectionRefs(query: string): string[] {
  const refs = new Set<string>();
  for (const match of query.matchAll(/(?:section|sec\.?|§)\s*(\d{1,2}(?:\.\d{1,2}){0,3})/gi)) refs.add(match[1]);
  for (const match of query.matchAll(/第\s*(\d{1,2})\s*[节章]/g)) refs.add(match[1]);
  return [...refs];
}

const PAGE_MARK = /【第\s*(\d+)\s*页】/g;
const LEADING_PAGE_MARK = /^\s*【第\s*(\d+)\s*页】/;
const SECTION_HEADING = /(?:^|\n)(\d{1,2}(?:\.\d{1,2}){0,3})\.?[ \t]+[A-Z\u4e00-\u9fff][^\n]{0,80}(?=\n|$)/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** CJK terms match anywhere; Latin terms only at the start of a word, so "set" no longer hits "dataset" while "datasets" still hits "dataset". */
function termMatcher(term: string): (lower: string) => boolean {
  if (/[^\x00-\x7f]/.test(term)) return (lower) => lower.includes(term);
  const stem = term.length > 4 && term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term;
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(stem)}`);
  return (lower) => pattern.test(lower);
}

interface ChunkMeta {
  page: number;
  sections: string[];
}

/** The page and section each chunk starts in, carried across chunks so every excerpt can say where it came from. */
function chunkMeta(chunks: string[]): ChunkMeta[] {
  let page = 0;
  let section = "";
  return chunks.map((text) => {
    const leading = LEADING_PAGE_MARK.exec(text);
    const meta: ChunkMeta = { page: leading ? Number(leading[1]) : page, sections: section ? [section] : [] };
    for (const match of text.matchAll(PAGE_MARK)) page = Number(match[1]);
    for (const match of text.matchAll(SECTION_HEADING)) {
      section = match[1];
      if (!meta.sections.includes(section)) meta.sections.push(section);
    }
    return meta;
  });
}

function inSection(meta: ChunkMeta, refs: string[]): boolean {
  return refs.some((ref) => meta.sections.some((section) => section === ref || section.startsWith(`${ref}.`)));
}

/** A chunk that starts mid-page gets the page it continues, so page citations stay grounded in the excerpt. */
function withPageLabel(text: string, page: number): string {
  if (!page || LEADING_PAGE_MARK.test(text)) return text;
  return `【第 ${page} 页（续）】\n${text}`;
}

/**
 * Materials within `cap` characters, picked by relevance to `query`. Returns null when everything already
 * fits or the query has no usable terms, so the caller keeps its plain packing.
 */
export function selectMaterial(materials: MaterialLike[], query: string, cap: number): string | null {
  const total = materials.reduce((sum, item) => sum + item.text.trim().length + item.name.length + 24, 0);
  if (total <= cap) return null;
  const keys = queryTerms(query);
  const refs = sectionRefs(query);
  if (!keys.length && !refs.length) return null;
  const pieces: Array<{ m: number; i: number; text: string; lower: string; inRef: boolean; score: number }> = [];
  const counts = materials.map((item, m) => {
    const chunks = chunkText(item.text.trim());
    const metas = chunkMeta(chunks);
    chunks.forEach((raw, i) => {
      pieces.push({ m, i, text: withPageLabel(raw, metas[i].page), lower: raw.toLowerCase(), inRef: refs.length > 0 && inSection(metas[i], refs), score: 0 });
    });
    return chunks.length;
  });
  // Rarer terms say more about where the answer sits: weight each term by its inverse document frequency over all chunks.
  const matchers = keys.map(termMatcher);
  const hits = pieces.map((piece) => matchers.map((match) => match(piece.lower)));
  const weights = keys.map((_, k) => {
    const df = hits.reduce((sum, row) => sum + (row[k] ? 1 : 0), 0);
    return df ? Math.log(1 + pieces.length / df) : 0;
  });
  const topWeight = weights.reduce((max, weight) => Math.max(max, weight), 0) || 1;
  pieces.forEach((piece, p) => {
    piece.score = hits[p].reduce((sum, hit, k) => sum + (hit ? weights[k] : 0), 0) + (piece.inRef ? 3 * topWeight : 0);
  });
  let budget = cap - materials.length * 70;
  const chosen = new Set<string>();
  const take = (piece: { m: number; i: number; text: string }) => {
    const id = `${piece.m}:${piece.i}`;
    if (chosen.has(id) || piece.text.length + 8 > budget) return;
    chosen.add(id);
    budget -= piece.text.length + 8;
  };
  // The opening chunk of every file gives the model its overview; then the most relevant chunks; then reading order.
  pieces.filter((piece) => piece.i === 0).forEach(take);
  [...pieces].filter((piece) => piece.score > 0).sort((a, b) => b.score - a.score || a.m - b.m || a.i - b.i).forEach(take);
  pieces.forEach(take);
  return materials
    .map((item, m) => {
      const picked = pieces.filter((piece) => piece.m === m && chosen.has(`${piece.m}:${piece.i}`));
      const body = picked.length
        ? picked.map((piece, index) => (index > 0 && picked[index - 1].i !== piece.i - 1 ? "…\n" : "") + piece.text).join("\n\n")
        : "（篇幅所限，本轮未选入；需要时请点名这份资料）";
      return `### 《${item.name}》·${item.kind}·${item.text.trim().length}字（按与本轮问题的相关度节选 ${picked.length}/${counts[m]} 段，每段标有所在页码）\n${body}`;
    })
    .join("\n\n");
}
const INTENT_NAME: Record<string, string> = {
  draft: "撰写完整的发明专利申请文件",
  ideas: "挖掘发明点",
  disclosure: "整理技术交底",
  search: "查新检索",
  read: "解读资料",
  chart: "技术特征对照",
  chat: "继续对话",
};

export function chinaDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(now);
}

/** The agent's environment for this turn, prepended to the user message. */
export function environmentBlock(input: { intent: string; materials: MaterialLike[]; turns: number; tools: boolean; now?: Date }): string {
  const files = input.materials.length
    ? input.materials.map((item) => `《${item.name}》（${item.text.trim().length} 字）`).join("、")
    : "无";
  return [
    "【运行环境】",
    "- 平台：PatentFlow 发明专利撰写工作台，用户是发明人或专利代理师，全程使用简体中文。",
    `- 当前日期：${chinaDate(input.now)}（北京时间）。“最新”“近年”等表述以此为准。`,
    `- 本轮任务：${INTENT_NAME[input.intent] ?? "继续对话"}。`,
    `- 联网：${input.tools ? "本轮可以调用联网检索工具，引用检索结果时给出来源" : "本轮不联网，只依据下面提供的资料、记忆和对话"}。`,
    `- 本轮资料：${files}；此前对话 ${input.turns} 条。`,
    input.intent === "read"
      ? "- 输出：遵守用户指定的长度与格式，仅解读资料；未记载的信息说明未记载，不补充参考参数、启发或内部状态 JSON。"
      : "- 输出：Markdown；不得编造实验数据、公开号、网址和引用；资料中没有的信息写成所属领域常规的取值范围及其确定方法，需要发明人提供的事项列入结尾 json 的 pending，正文不写任何【待……】占位。",
  ].join("\n");
}
