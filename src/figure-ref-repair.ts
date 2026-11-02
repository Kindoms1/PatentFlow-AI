/**
 * 附图标记的确定性修复：导出前形式核查（附图核查）的兜底，不调用模型。
 *
 * 只处理不需要补写内容就能确定的三种情形，其余仍交给模型按核查结果修正：
 * 1. 图中画了、附图标记列表没有，但名称可以确定的标记（框图方框里的文字，或正文里“部件名+标记”的写法）：
 *    按列表原有格式补列；
 * 2. 图中画了、没有任何名称、说明书各处也没有提到的标记（如曲线图坐标轴上随手写的 410、411）：
 *    去掉该图元的附图标记（图元本身照画，只是不再引出标记）；
 * 3. 附图标记列表列了、没有任何附图画出、说明书各处也没有提到的标记：从列表中删去。
 * 4. 仅在 unrefUndrawn 选项下（模型修正之后的兜底）：附图标记列表列了、没有任何附图画出、
 *    说明书和权利要求里只以“列表中的部件名+标记”形式引用的部件：去掉这些标记引用（部件名称保留），并从列表删去；
 *    该数字还接在别的文字后面（可能指别的部件）或在列表以外以“标记—名称”写法出现时不动，交给模型。
 *
 * “列表里有没有”“图里画没画”与 formalCheck 使用同一套解析（parseApplication）；
 * “说明书有没有提到”比核查更保守：除绘图数据和列表本身外，全文任何地方出现该数字都算提到。
 * 两步修改（去掉图元标记、增删列表项）各自改完重新解析核对，结果与预期不符就放弃这一步。
 */
import { parseApplication } from "./cnipa-format.ts";
import { parseReferenceList, textReferences } from "./figure-audit.ts";
import type { ReferenceEntry } from "./figure-audit.ts";
import { FIGURE_FENCE, figureSpecRefs, looksLikeFigureJson, parseFigureJson, plainLabel, stripDraftJsonTail } from "./figure-spec.ts";
import type { FigureSpec } from "./figure-spec.ts";

export interface StrippedRef {
  ref: string;
  /** 画有该标记的图号。 */
  figures: number[];
}

export interface FigureRefRepair {
  text: string;
  /** 补列进附图标记列表的条目。 */
  added: ReferenceEntry[];
  /** 从附图标记列表删去的条目。 */
  removed: ReferenceEntry[];
  /** 从绘图数据里去掉的无名称标记。 */
  stripped: StrippedRef[];
  /** 没有附图画出、去掉了说明书与权利要求中的标记引用并从列表删去的部件（仅 unrefUndrawn）。 */
  unreferenced: ReferenceEntry[];
  /** 合写标记按同组图元位置补标的图元（fillGroupRefs）。 */
  assigned?: AssignedRef[];
  /** 给过程日志用的修改说明；为空表示没有修改。 */
  changes: string[];
}

export interface FigureRefRepairOptions {
  /**
   * 对“附图标记列表列了、没有任何附图画出、正文只以部件名+标记引用”的部件，去掉标记引用并从列表删去。
   * 默认关闭：这类部件应先让模型补画进附图，只在模型修正之后仍不通过时作为兜底开启。
   */
  unrefUndrawn?: boolean;
}

/** 半开区间 [start, end) 的行号。 */
interface LineRange {
  start: number;
  end: number;
}

const JSON_FENCE = /^```\s*json\s*$/i;
const CLOSE_FENCE = /^```\s*$/;
const HEADING = /^#{1,6}\s/;
const LIST_HEADING = /^#{2,4}\s*附图标记(?:说明|列表)?\s*[:：]?\s*$/;
const LIST_PARAGRAPH = /^\s*(?:[-*+]\s+)?附图标记(?:说明|列表)?\s*[:：]/;
/** 标记与名称之间的分隔，与 figure-audit 的 REF_ENTRY 一致。 */
const REF_NAME_SEP = "(?:[—–\\-－~～、:：.．]|\\s)";
/** 列表解析器不认的名称字符：含这些字符的名称写进列表也读不回来。 */
const NAME_FORBIDDEN = /[；;，,。—–－、:：\n\r]/;
const INSTANCE = /^(\d{1,4})[a-z]$/;
/** 正文“部件名+标记”里部件名前面常带的句子成分，取最后一处之后的部分作名称。 */
const LEAD_WORDS = /^.*(?:所述|通过|位于|包括|包含|采用|利用|的|于|将|与|和|及|其|该)/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function refOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** 文字中是否以独立数字的形式出现该标记（前后都不是数字或小数点）。 */
function mentions(text: string, ref: string): boolean {
  return new RegExp(`(?<![\\d.])${escapeRegExp(ref)}(?!\\d|\\.\\d)`).test(text);
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
}

/** 能写进附图标记列表、并能被同一解析器原样读回的部件名称；不满足时返回空串。 */
function listableName(raw: string, ref: string): string {
  const name = plainLabel(raw).replace(/[\s（）()【】]/g, "");
  if (name.length < 2 || name.length > 30 || NAME_FORBIDDEN.test(name) || !/[\u4e00-\u9fa5]/.test(name)) return "";
  const parsed = parseReferenceList(`${ref}—${name}`);
  return parsed.length === 1 && parsed[0].ref === ref && parsed[0].name === name ? name : "";
}

/** 正文“部件名+标记”里的部件名：去掉“所述”“……的”等前缀后仍是 2～12 字的可列名称才采用。 */
function textName(raw: string, ref: string): string {
  const trimmed = raw.replace(LEAD_WORDS, "");
  return trimmed.length >= 2 && trimmed.length <= 12 ? listableName(trimmed, ref) : "";
}

/** 各图画出的标记 → 画有该标记的图号。 */
function drawnRefs(specs: FigureSpec[]): Map<string, number[]> {
  const refs = new Map<string, number[]>();
  for (const spec of specs) {
    for (const ref of figureSpecRefs(spec)) {
      const figures = refs.get(ref) ?? [];
      if (!figures.includes(spec.no)) figures.push(spec.no);
      refs.set(ref, figures);
    }
  }
  return refs;
}

/** 只画在结构图图元或剖面图分层上的标记才能去掉：框图方框有文字、剖面图部件必须带标记，都交给模型。 */
function strippable(specs: FigureSpec[], ref: string): boolean {
  const elsewhere = specs.some((spec) => spec.items.some((item) => item.ref === ref) || spec.nodes.some((node) => node.ref === ref));
  const onShapes = specs.some((spec) => spec.shapes.some((shape) => shape.ref === ref) || spec.layers.some((layer) => layer.ref === ref));
  return onShapes && !elsewhere;
}

/** 绘图数据代码块（含误标成 ```json 的附图块）所在行，判定规则与 extractFigureSpecs 一致；只返回闭合的代码块。 */
function figureBlocks(lines: string[]): LineRange[] {
  const blocks: LineRange[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const fence = lines[index].trim();
    const figure = FIGURE_FENCE.test(fence);
    if (!figure && !JSON_FENCE.test(fence)) continue;
    let close = -1;
    for (let at = index + 1; at < lines.length; at += 1) {
      const inner = lines[at].trim();
      if (CLOSE_FENCE.test(inner)) {
        close = at;
        break;
      }
      if (!figure && inner.startsWith("```")) break;
    }
    if (close < 0) {
      if (figure) break;
      continue;
    }
    if (figure || looksLikeFigureJson(lines.slice(index + 1, close).join("\n"))) {
      blocks.push({ start: index, end: close + 1 });
      index = close;
    }
  }
  return blocks;
}

/** 附图标记列表所在行：优先“### 附图标记”小节（到下一个标题或代码块为止），否则是附图说明以外的“附图标记：……”段落。 */
function referenceRange(lines: string[], blocks: LineRange[]): LineRange | null {
  const inside = (index: number) => blocks.some((block) => index >= block.start && index < block.end);
  const stops = (line: string) => HEADING.test(line.trim()) || line.trim().startsWith("```");
  for (let index = 0; index < lines.length; index += 1) {
    if (inside(index) || !LIST_HEADING.test(lines[index].trim())) continue;
    let end = index + 1;
    while (end < lines.length && !stops(lines[end])) end += 1;
    return { start: index + 1, end };
  }
  let part = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^##\s/.test(line)) part = line;
    if (inside(index) || /附图说明/.test(part) || !LIST_PARAGRAPH.test(line)) continue;
    let end = index + 1;
    while (end < lines.length && lines[end].trim() && !stops(lines[end])) end += 1;
    return { start: index, end };
  }
  return null;
}

/** 可以确定名称的标记：框图方框文字优先，其次是正文里出现最多（同样多时取最短）的“部件名+标记”。 */
function nameCandidates(specs: FigureSpec[], prose: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const spec of specs) {
    for (const node of spec.nodes) {
      if (!node.ref || names.has(node.ref)) continue;
      const name = listableName(node.text, node.ref);
      if (name) names.set(node.ref, name);
    }
  }
  const counts = new Map<string, Map<string, number>>();
  for (const entry of textReferences(prose)) {
    if (names.has(entry.ref)) continue;
    const name = textName(entry.name, entry.ref);
    if (!name) continue;
    const byName = counts.get(entry.ref) ?? new Map<string, number>();
    byName.set(name, (byName.get(name) ?? 0) + 1);
    counts.set(entry.ref, byName);
  }
  for (const [ref, byName] of counts) {
    const best = [...byName].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
    if (best) names.set(ref, best[0]);
  }
  return names;
}

/** 同组图元补标的一条记录。 */
export interface AssignedRef {
  ref: string;
  figure: number;
}

type LooseShape = Record<string, unknown> & { kind?: string; ref?: string };

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 可以按左右位置排序的图元类别：圆、椭圆、矩形按中心 x，竖直的两点线按 x；其余（水平线、斜线、折线等）不参与。 */
function shapeSlot(shape: LooseShape): { kind: string; x: number } | null {
  const style = JSON.stringify([shape.dashed ?? null, shape.fill ?? null, shape.style ?? null]);
  if (shape.kind === "circle" || shape.kind === "ellipse") {
    const cx = num(shape.cx);
    return cx === null ? null : { kind: `${shape.kind}${style}`, x: cx };
  }
  if (shape.kind === "rect") {
    const x = num(shape.x);
    const w = num(shape.w);
    return x === null || w === null ? null : { kind: `rect${style}`, x: x + w / 2 };
  }
  if (shape.kind === "line" && Array.isArray(shape.points) && shape.points.length === 2) {
    const [a, b] = shape.points as unknown[];
    if (!Array.isArray(a) || !Array.isArray(b)) return null;
    const [ax, ay, bx, by] = [num(a[0]), num(a[1]), num(b[0]), num(b[1])];
    if (ax === null || ay === null || bx === null || by === null || ax !== bx || ay === by) return null;
    return { kind: `vline${style}`, x: ax };
  }
  return null;
}

/**
 * 合写的附图标记（“52、53、54—作物个体”）只画出了部分时，给同一幅图里同类、未标注的图元按左右位置补标。
 * 只在证据充分时修改：已画出的同组标记全部在同一幅图的图元上且类别相同，同类未标注图元数与缺少的标记数完全相等，
 * 位置不重合，并且补标后整组从左到右与列表顺序一致（同向或反向）。任一条件不满足就不动，保留核查错误。
 * 改写后重新解析核对；没有可补的标记时返回 null，重复执行不再改动。
 */
export function fillGroupRefs(markdown: string): { text: string; assigned: AssignedRef[]; change: string } | null {
  const app = parseApplication(markdown);
  const appSpecs = app.figureSpecs ?? [];
  const appIssues = app.figureSpecIssues ?? [];
  const groups = new Map<string, string[]>();
  for (const entry of app.references ?? []) if (entry.group && entry.group.length > 1) groups.set(entry.group.join("、"), entry.group);
  if (!groups.size) return null;
  const drawn = new Set(appSpecs.flatMap((spec) => figureSpecRefs(spec)));
  const plan = new Map<number, Map<number, string>>();
  for (const refs of groups.values()) {
    const missing = refs.filter((ref) => !drawn.has(ref));
    const present = refs.filter((ref) => drawn.has(ref));
    if (!missing.length || !present.length) continue;
    const homes = appSpecs.filter((spec) => figureSpecRefs(spec).some((ref) => present.includes(ref)));
    if (homes.length !== 1) continue;
    const spec = homes[0];
    const shapes = spec.shapes.map((shape, index) => ({ shape: shape as unknown as LooseShape, index }));
    const siblings = shapes.filter(({ shape }) => typeof shape.ref === "string" && present.includes(shape.ref));
    if (siblings.length !== present.length || new Set(siblings.map(({ shape }) => shape.ref)).size !== present.length) continue;
    const slots = siblings.map(({ shape }) => shapeSlot(shape));
    if (slots.some((slot) => !slot) || new Set(slots.map((slot) => slot?.kind)).size !== 1) continue;
    const kind = slots[0]!.kind;
    const taken = plan.get(spec.no) ?? new Map<number, string>();
    const free = shapes.filter(({ shape, index }) => !shape.ref && !taken.has(index) && shapeSlot(shape)?.kind === kind);
    if (free.length !== missing.length) continue;
    const row = [
      ...siblings.map(({ shape, index }) => ({ index, x: shapeSlot(shape)!.x, ref: shape.ref as string, fixed: true })),
      ...free.map(({ shape, index }) => ({ index, x: shapeSlot(shape)!.x, ref: "", fixed: false })),
    ];
    if (new Set(row.map((item) => item.x)).size !== row.length) continue;
    row.sort((a, b) => a.x - b.x);
    const open = row.filter((item) => !item.fixed);
    const monotone = (order: string[]): boolean => {
      open.forEach((item, position) => (item.ref = order[position]));
      const ranks = row.map((item) => refs.indexOf(item.ref));
      return ranks.every((rank, position) => position === 0 || rank > ranks[position - 1]) || ranks.every((rank, position) => position === 0 || rank < ranks[position - 1]);
    };
    if (!monotone(missing) && !monotone([...missing].reverse())) continue;
    for (const item of open) taken.set(item.index, item.ref);
    plan.set(spec.no, taken);
  }
  if (!plan.size) return null;

  const lines = markdown.split("\n");
  const out = [...lines];
  const pending = new Set(plan.keys());
  for (const block of [...figureBlocks(lines)].reverse()) {
    const body = lines.slice(block.start + 1, block.end - 1).join("\n");
    let raw: unknown;
    try {
      raw = parseFigureJson(body, []);
    } catch {
      continue;
    }
    let changed = false;
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      const item = record(entry);
      const no = item ? Number(item.no ?? item.figure) : NaN;
      const assign = plan.get(no);
      if (!item || !assign || !pending.has(no)) continue;
      const spec = appSpecs.find((candidate) => candidate.no === no);
      const list = item.shapes;
      if (!spec || !Array.isArray(list) || list.length !== spec.shapes.length) return null;
      for (const index of assign.keys()) {
        const part = record(list[index]);
        const rawKind = part ? String(part.kind ?? part.type ?? "").toLowerCase() : "";
        const parsedKind = (spec.shapes[index] as unknown as LooseShape).kind;
        if (!part || "ref" in part || (rawKind !== parsedKind && !(rawKind === "polyline" && parsedKind === "line"))) return null;
      }
      for (const [index, ref] of assign) (record(list[index]) as Record<string, unknown>).ref = ref;
      pending.delete(no);
      changed = true;
    }
    if (changed) out.splice(block.start + 1, block.end - 1 - (block.start + 1), JSON.stringify(raw));
  }
  if (pending.size) return null;

  const text = out.join("\n");
  const after = parseApplication(text);
  const assigned: AssignedRef[] = [...plan].flatMap(([figure, assign]) => [...assign.values()].map((ref) => ({ ref, figure })));
  const nowDrawn = new Set((after.figureSpecs ?? []).flatMap((spec) => figureSpecRefs(spec)));
  if (
    (after.figureSpecs ?? []).length !== appSpecs.length ||
    (after.figureSpecIssues ?? []).length > appIssues.length ||
    assigned.some(({ ref }) => !nowDrawn.has(ref)) ||
    [...drawn].some((ref) => !nowDrawn.has(ref))
  ) {
    return null;
  }
  const change = [...plan].map(([figure, assign]) => `图${figure}按同组图元的左右位置补标 ${[...assign.values()].join("、")}`).join("；");
  return { text, assigned, change };
}
/** 去掉绘图数据里结构图图元、剖面图分层上的指定标记；只重写确有改动的代码块。 */
function stripRefs(lines: string[], blocks: LineRange[], refs: Set<string>): string[] | null {
  const out = [...lines];
  let touched = false;
  for (const block of [...blocks].reverse()) {
    const body = lines.slice(block.start + 1, block.end - 1).join("\n");
    let raw: unknown;
    try {
      raw = parseFigureJson(body, []);
    } catch {
      continue;
    }
    let changed = false;
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      const item = record(entry);
      if (!item) continue;
      for (const key of ["shapes", "layers"]) {
        const list = item[key];
        if (!Array.isArray(list)) continue;
        for (const element of list) {
          const part = record(element);
          if (part && "ref" in part && refs.has(refOf(part.ref))) {
            delete part.ref;
            changed = true;
          }
        }
      }
    }
    if (!changed) continue;
    out.splice(block.start + 1, block.end - 1 - (block.start + 1), JSON.stringify(raw));
    touched = true;
  }
  return touched ? out : null;
}

function trailingMark(line: string): string {
  return /([；;。.，,]?)\s*$/.exec(line)?.[1] ?? "";
}

/** 删去一条列表项后整理分隔符；行里不再有内容时返回 null（整行删去）。 */
function cleanupListLine(line: string): string | null {
  const cleaned = line
    .replace(/([:：]\s*)[；;，,、]\s*/, "$1")
    .replace(/[；;，,、]\s*([。.]?)\s*$/, "$1")
    .replace(/^(\s*)[；;，,、]\s*/, "$1")
    .replace(/\s+$/, "");
  return /^\s*(?:[-*+]|\d+[.、）)])?\s*[。.]?\s*$/.test(cleaned) ? null : cleaned;
}

/** 从列表行中删去一条“标记—名称”；找不到时返回 null。 */
function removeEntry(lines: string[], entry: ReferenceEntry): string[] | null {
  const name = [...entry.name].map(escapeRegExp).join("[\\s（）()【】]*");
  const pattern = new RegExp(
    `(^|[；;，,、:：\\s])((?:[-*+]\\s+)?)${escapeRegExp(entry.ref)}\\s*${REF_NAME_SEP}\\s*[（(【]?${name}[）)】]?(?=\\s*(?:[；;，,。.]|$))\\s*[；;，,]?`,
  );
  const out: string[] = [];
  let found = false;
  for (const line of lines) {
    if (found || !pattern.test(line)) {
      out.push(line);
      continue;
    }
    found = true;
    const rest = cleanupListLine(line.replace(pattern, "$1"));
    if (rest !== null) {
      out.push(rest);
      continue;
    }
    // 整行删去的是以句号收尾的末条时，把上一条的分号改成句号
    const ending = trailingMark(line);
    if (/^[。.]$/.test(ending)) {
      for (let at = out.length - 1; at >= 0; at -= 1) {
        if (!parseReferenceList(out[at]).length) continue;
        out[at] = out[at].replace(/[；;，,]?\s*$/, ending);
        break;
      }
    }
  }
  return found ? out : null;
}

/** 按列表原有格式补列条目：逐行列出的接在末行之后，写在一段里的接在末条之后；列表里没有可参照的条目时返回 null。 */
function addEntries(lines: string[], entries: ReferenceEntry[]): string[] | null {
  const entryLines = lines
    .map((line, index) => ({ line, index, found: parseReferenceList(line) }))
    .filter((item) => item.found.length > 0);
  const last = entryLines[entryLines.length - 1];
  if (!last || !entries.length) return null;
  const sample = last.found[last.found.length - 1];
  const sepMatch = new RegExp(`(?<![\\d.])${escapeRegExp(sample.ref)}(\\s*${REF_NAME_SEP}\\s*)`).exec(last.line);
  const refSep = sepMatch ? sepMatch[1] : "—";
  const out = [...lines];
  if (entryLines.length >= 2 && entryLines.every((item) => item.found.length === 1)) {
    const prefix = /^\s*(?:[-*+]\s+)?/.exec(last.line)?.[0] ?? "";
    const ending = trailingMark(last.line);
    const previous = trailingMark(entryLines[entryLines.length - 2].line);
    let inner = ending;
    if (ending !== previous && /^[。.]$/.test(ending)) {
      out[last.index] = last.line.replace(/[。.]\s*$/, previous);
      inner = previous;
    }
    const added = entries.map((entry, index) => `${prefix}${entry.ref}${refSep}${entry.name}${index === entries.length - 1 ? ending : inner}`);
    out.splice(last.index + 1, 0, ...added);
    return out;
  }
  const trail = /([；;。.，,]?)(\s*)$/.exec(last.line);
  const mark = trail?.[1] ?? "";
  const base = last.line.slice(0, last.line.length - (trail?.[0].length ?? 0));
  const sep = last.line.includes("；") ? "；" : last.line.includes(";") ? ";" : last.line.includes("，") ? "，" : "；";
  out[last.index] = `${base}${entries.map((entry) => `${sep}${entry.ref}${refSep}${entry.name}`).join("")}${mark}`;
  return out;
}

function firstNames(entries: ReferenceEntry[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const entry of entries) if (!names.has(entry.ref)) names.set(entry.ref, entry.name);
  return names;
}

function entryText(entries: ReferenceEntry[]): string {
  return entries.map((entry) => `${entry.ref}—${entry.name}`).join("、");
}

/** 数字前是这些词时，是权利要求号、图号、实施例号、步骤号或序数，不是部件的附图标记。 */
const NOT_REF_LEAD = /(?:权利要求|图|实施例|步骤|第|式|表|[Ss])$/;
/** 数字前是这些词时是取值（“设为32”“步长为15”），不是别的部件的标记。 */
const VALUE_LEAD = /(?:为|是|取|设|约|至|到|和|或|与|及|共|达|于|前|后|每|等于|大小|尺寸|数量|个数|维度|步长|长度|宽度|高度|深度|阈值|系数|倍率|层数|通道数)$/;
/** 数字后接单位或量词时是取值（“32个通道”“15层”“32×32”）。 */
const VALUE_TAIL = /^\s*(?:个|种|维|位|次|倍|帧|组|路|条|项|张|幅|层|像素|通道|%|％|mm|cm|nm|μm|um|ms|Hz|kHz|MHz|GHz|dB|°|℃|bit|比特|字节|KB|MB|GB|[×xX*]\s*\d)/;

/** 名称各字之间允许空白的正则片段。 */
function namePattern(name: string): string {
  return [...name].map(escapeRegExp).join("\\s*");
}

/** 正文里“部件名+标记”的写法：部件名(70)、部件名（70）、部件名70；第 1 组是部件名本身。 */
function attachedRefPattern(entry: ReferenceEntry, flags = "g"): RegExp {
  const ref = escapeRegExp(entry.ref);
  return new RegExp(`(${namePattern(entry.name)})\\s*(?:[（(]\\s*${ref}\\s*[)）]|${ref}(?!\\d|\\.\\d|[a-z]))`, flags);
}

/**
 * 能否只去掉标记引用：可编辑行里该数字的每一处独立出现，要么紧跟在列表中的部件名后面，
 * 要么前面不是文字（表格数值、数值范围等）或是权利要求号、图号之类的编号。
 * 该数字还接在别的文字后面（可能指别的部件）或以“标记—名称”的列表写法出现时返回 null；
 * 否则返回“部件名+标记”引用的处数（可以为 0：只在列表里有，正文中只是同样的数值）。
 */
function unrefCount(lines: string[], editable: (index: number) => boolean, entry: ReferenceEntry): number | null {
  const bare = new RegExp(`(?<![\\d.])${escapeRegExp(entry.ref)}(?!\\d|\\.\\d|[a-z])`, "g");
  const listStyle = new RegExp(`^\\s*${REF_NAME_SEP}\\s*[（(【]?${namePattern(entry.name)}`);
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!editable(index)) continue;
    const line = lines[index];
    count += line.match(attachedRefPattern(entry))?.length ?? 0;
    const rest = line.replace(attachedRefPattern(entry), "$1");
    for (const match of rest.matchAll(bare)) {
      const at = match.index ?? 0;
      const lead = rest.slice(0, at).replace(/\s*[（(【]?\s*$/, "");
      if (/[\u4e00-\u9fa5A-Za-z]$/.test(lead) && !NOT_REF_LEAD.test(lead) && !VALUE_LEAD.test(lead) && !VALUE_TAIL.test(rest.slice(at + entry.ref.length))) return null;
      if (listStyle.test(rest.slice(at + entry.ref.length))) return null;
    }
  }
  return count;
}

/** 去掉可编辑行里“部件名+标记”引用中的标记，部件名保留。 */
function unrefLines(lines: string[], editable: (index: number) => boolean, entry: ReferenceEntry): string[] {
  return lines.map((line, index) => (editable(index) ? line.replace(attachedRefPattern(entry), "$1") : line));
}

/** 对草稿（可带末尾 json 块）做附图标记的确定性修复；没有可修的内容时原样返回、changes 为空。 */
export function repairFigureRefs(markdown: string, options: FigureRefRepairOptions = {}): FigureRefRepair {
  // 0. 合写标记只画出部分时先按同组图元补标，再走下面的增删步骤，避免把可以补标的条目当成“未画出”删掉。
  const filled = fillGroupRefs(markdown);
  if (filled) {
    const rest = repairFigureRefs(filled.text, options);
    return { ...rest, assigned: [...filled.assigned, ...(rest.assigned ?? [])], changes: [filled.change, ...rest.changes] };
  }
  const unchanged: FigureRefRepair = { text: markdown, added: [], removed: [], stripped: [], unreferenced: [], changes: [] };
  const app = parseApplication(markdown);
  const specs = app.figureSpecs ?? [];
  const references = app.references ?? [];
  if (!specs.length || !references.length) return unchanged;

  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const blocks = figureBlocks(lines);
  const range = referenceRange(lines, blocks);
  if (!range) return unchanged;

  const listed = firstNames(references);
  const listedNames = new Set(listed.values());
  const figureRefs = drawnRefs(specs);
  const instanceBase = (ref: string): string | null => {
    const base = INSTANCE.exec(ref)?.[1];
    return base && !listed.has(ref) && listed.has(base) ? base : null;
  };
  const excluded = new Set<number>();
  for (const block of blocks) for (let index = block.start; index < block.end; index += 1) excluded.add(index);
  for (let index = range.start; index < range.end; index += 1) excluded.add(index);
  const prose = stripDraftJsonTail(lines.filter((_, index) => !excluded.has(index)).join("\n"));
  const named = nameCandidates(specs, prose);

  const toAdd: ReferenceEntry[] = [];
  const toStrip: StrippedRef[] = [];
  for (const [ref, figures] of figureRefs) {
    if (listed.has(ref) || instanceBase(ref)) continue;
    const name = named.get(ref);
    if (name && !listedNames.has(name) && !toAdd.some((entry) => entry.name === name)) toAdd.push({ ref, name });
    else if (!mentions(prose, ref) && strippable(specs, ref)) toStrip.push({ ref, figures });
  }
  const drawn = new Set([...figureRefs.keys()].map((ref) => instanceBase(ref) ?? ref));
  // 合写条目（“52、53、54—作物个体”）里的单个标记不自动删除或去引用：单独删去其中一个会留下残缺的合写，留给核查和模型处理。
  const grouped = new Set(references.filter((entry) => (entry.group?.length ?? 0) > 1).map((entry) => entry.ref));
  const toRemove = [...listed]
    .filter(([ref]) => !grouped.has(ref) && !drawn.has(ref) && !mentions(prose, ref))
    .map(([ref, name]) => ({ ref, name }));
  const removable = new Set(toRemove.map((entry) => entry.ref));
  const editableLine = (index: number) => !excluded.has(index);
  const toUnref: ReferenceEntry[] = options.unrefUndrawn
    ? [...listed]
        .filter(([ref]) => !grouped.has(ref) && !drawn.has(ref) && !removable.has(ref) && references.filter((entry) => entry.ref === ref).length === 1)
        .map(([ref, name]) => ({ ref, name }))
        .filter((entry) => unrefCount(lines, editableLine, entry) !== null)
    : [];
  if (!toAdd.length && !toStrip.length && !toRemove.length && !toUnref.length) return unchanged;

  // 第一步：去掉无名称、未引用的图元标记。重新解析后，各图画出的标记必须恰好少了这些，图数不变。
  let text = markdown;
  let stripped: StrippedRef[] = [];
  if (toStrip.length) {
    const stripSet = new Set(toStrip.map((item) => item.ref));
    const candidateLines = stripRefs(lines, blocks, stripSet);
    if (candidateLines) {
      const candidate = candidateLines.join(eol);
      const candidateSpecs = parseApplication(candidate).figureSpecs ?? [];
      const expected = new Set([...figureRefs.keys()].filter((ref) => !stripSet.has(ref)));
      if (candidateSpecs.length === specs.length && sameSet(new Set(drawnRefs(candidateSpecs).keys()), expected)) {
        text = candidate;
        stripped = toStrip;
      }
    }
  }

  // 第二步：增删列表项。重新解析后，列表必须恰好是原列表去掉删去项、加上补列项，其余条目名称不变。
  let added: ReferenceEntry[] = [];
  let removed: ReferenceEntry[] = [];
  if (toAdd.length || toRemove.length) {
    const current = text.split(/\r?\n/);
    const currentRange = referenceRange(current, figureBlocks(current));
    if (currentRange) {
      let rangeLines = current.slice(currentRange.start, currentRange.end);
      const removedOk: ReferenceEntry[] = [];
      for (const entry of toRemove) {
        const next = removeEntry(rangeLines, entry);
        if (!next) continue;
        rangeLines = next;
        removedOk.push(entry);
      }
      let addedOk: ReferenceEntry[] = [];
      if (toAdd.length) {
        const next = addEntries(rangeLines, toAdd);
        if (next) {
          rangeLines = next;
          addedOk = toAdd;
        }
      }
      if (removedOk.length || addedOk.length) {
        const candidate = [...current.slice(0, currentRange.start), ...rangeLines, ...current.slice(currentRange.end)].join(eol);
        const expected = new Map(listed);
        for (const entry of removedOk) expected.delete(entry.ref);
        for (const entry of addedOk) expected.set(entry.ref, entry.name);
        if (sameMap(firstNames(parseApplication(candidate).references ?? []), expected)) {
          text = candidate;
          added = addedOk;
          removed = removedOk;
        }
      }
    }
  }

  // 第三步（仅 unrefUndrawn）：没有附图画出、正文只以“部件名+标记”引用的部件，去掉说明书、权利要求中的标记（部件名保留）并从列表删去。
  // 重新解析后，列表必须恰好少了这些条目，图数和各图画出的标记不变，正文中也不再有这些“部件名+标记”，否则放弃这一步。
  let unreferenced: ReferenceEntry[] = [];
  if (toUnref.length) {
    const current = text.split(/\r?\n/);
    const currentBlocks = figureBlocks(current);
    const currentRange = referenceRange(current, currentBlocks);
    if (currentRange) {
      const fixed = new Set<number>();
      for (const block of currentBlocks) for (let index = block.start; index < block.end; index += 1) fixed.add(index);
      for (let index = currentRange.start; index < currentRange.end; index += 1) fixed.add(index);
      const editable = (index: number) => !fixed.has(index);
      let bodyLines = current;
      let rangeLines = current.slice(currentRange.start, currentRange.end);
      const done: ReferenceEntry[] = [];
      for (const entry of toUnref) {
        if (unrefCount(bodyLines, editable, entry) === null) continue;
        const next = removeEntry(rangeLines, entry);
        if (!next) continue;
        rangeLines = next;
        bodyLines = unrefLines(bodyLines, editable, entry);
        done.push(entry);
      }
      if (done.length) {
        const candidate = [...bodyLines.slice(0, currentRange.start), ...rangeLines, ...bodyLines.slice(currentRange.end)].join(eol);
        const before = parseApplication(text);
        const after = parseApplication(candidate);
        const expected = firstNames(before.references ?? []);
        for (const entry of done) expected.delete(entry.ref);
        const beforeSpecs = before.figureSpecs ?? [];
        const afterSpecs = after.figureSpecs ?? [];
        const candidateLines = candidate.split(/\r?\n/);
        const candidateBlocks = figureBlocks(candidateLines);
        const candidateRange = referenceRange(candidateLines, candidateBlocks);
        const outside = (index: number) =>
          !candidateBlocks.some((block) => index >= block.start && index < block.end) &&
          !(candidateRange && index >= candidateRange.start && index < candidateRange.end);
        const leftover = done.some((entry) => candidateLines.some((line, index) => outside(index) && attachedRefPattern(entry, "").test(line)));
        if (
          !leftover &&
          sameMap(firstNames(after.references ?? []), expected) &&
          afterSpecs.length === beforeSpecs.length &&
          sameSet(new Set(drawnRefs(afterSpecs).keys()), new Set(drawnRefs(beforeSpecs).keys()))
        ) {
          text = candidate;
          unreferenced = done;
        }
      }
    }
  }

  const changes: string[] = [];
  const byFigure = new Map<number, string[]>();
  for (const item of stripped) for (const no of item.figures) byFigure.set(no, [...(byFigure.get(no) ?? []), item.ref]);
  for (const [no, refs] of [...byFigure].sort((a, b) => a[0] - b[0])) {
    changes.push(`图${no}中的 ${refs.join("、")} 没有部件名称，说明书也没有引用，去掉其附图标记（图形保留）`);
  }
  if (added.length) changes.push(`附图标记列表补列 ${entryText(added)}`);
  if (removed.length) changes.push(`附图标记列表删去没有附图画出、说明书也没有引用的 ${entryText(removed)}`);
  if (unreferenced.length) {
    changes.push(`附图标记列表中的 ${entryText(unreferenced)} 没有任何附图画出，去掉说明书和权利要求中对其的标记引用（部件名称保留），并从附图标记列表删去`);
  }
  if (!changes.length) return unchanged;
  return { text, added, removed, stripped, unreferenced, changes };
}
