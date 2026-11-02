/**
 * 「专利分类与样例」区域的纯逻辑：筛选、选项、标签、导出计划。
 * 不依赖 React，便于用 node --test 直接测试；界面在 library-panel.tsx。
 */
import { LIBRARY_DISCLAIMER, REAL_REFERENCES, TECH_DOMAINS, findSample, libraryEntries, searchLibrary } from "./patent-library.ts";
import type { LibraryEntry, LibraryEntryKind } from "./patent-library.ts";

export type LibraryKindFilter = LibraryEntryKind | "all";

export interface LibraryQuery {
  query: string;
  domainId: string;
  ipc: string;
  kind: LibraryKindFilter;
}

export const EMPTY_LIBRARY_QUERY: LibraryQuery = { query: "", domainId: "all", ipc: "", kind: "all" };

export const KIND_OPTIONS: Array<{ id: LibraryKindFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "domain", label: "领域指引" },
  { id: "sample", label: "虚构示范样例" },
  { id: "reference", label: "真实参考资料" },
];

export { LIBRARY_DISCLAIMER };

export function kindLabel(kind: LibraryEntryKind): string {
  if (kind === "sample") return "虚构示范样例";
  if (kind === "reference") return "真实参考资料";
  return "领域指引";
}

/** 技术领域下拉框：首项为「全部领域」，不含兜底的通用领域。 */
export function domainOptions(): Array<{ id: string; label: string }> {
  return [{ id: "all", label: "全部领域" }, ...TECH_DOMAINS.filter((domain) => domain.id !== "general").map((domain) => ({ id: domain.id, label: domain.name }))];
}

function subclassOf(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "").slice(0, 4);
}

/**
 * IPC 候选项（小类级，例如 G06T、A61B），只来自知识库中已有的 IPC，不另行编造。
 * 选定领域时只列该领域条目出现过的小类。类名取领域表中的简称，正式类名以现行 IPC 版本为准。
 */
export function ipcOptions(domainId: string): Array<{ code: string; label: string }> {
  const labels = new Map<string, string>();
  for (const domain of TECH_DOMAINS) {
    for (const item of domain.ipc) {
      const sub = subclassOf(item.code);
      const exact = subclassOf(item.code) === item.code.trim().toUpperCase().replace(/\s+/g, "");
      if (!labels.has(sub) || exact) labels.set(sub, item.label);
    }
  }
  const seen = new Set<string>();
  for (const entry of libraryEntries()) {
    if (domainId && domainId !== "all" && !entry.domainIds.includes(domainId as LibraryEntry["domainIds"][number])) continue;
    for (const code of entry.ipc) {
      const sub = subclassOf(code);
      if (/^[A-H]\d{2}[A-Z]$/.test(sub)) seen.add(sub);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b)).map((code) => ({ code, label: labels.get(code) ?? "" }));
}

export type LibraryView =
  | { ok: true; entries: LibraryEntry[]; total: number }
  | { ok: false; error: string; entries: LibraryEntry[]; total: number };

/** 按关键词、领域、IPC 前缀和类型筛选。知识库读取出错时返回 ok:false 和错误说明，界面据此显示错误状态。 */
export function libraryView(query: LibraryQuery): LibraryView {
  try {
    const total = libraryEntries().length;
    const entries = searchLibrary(query.query, { domainId: query.domainId, ipc: query.ipc, kind: query.kind });
    return { ok: true, entries, total };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), entries: [], total: 0 };
  }
}

export function isFiltered(query: LibraryQuery): boolean {
  return Boolean(query.query.trim() || query.ipc.trim() || (query.domainId && query.domainId !== "all") || query.kind !== "all");
}

/** 当前选中项：选中的 id 不在结果里时退回第一条，结果为空时为 null。 */
export function pickEntry(entries: LibraryEntry[], id: string): LibraryEntry | null {
  return entries.find((entry) => entry.id === id) ?? entries[0] ?? null;
}

function referenceOf(entry: LibraryEntry) {
  if (entry.kind !== "reference") return null;
  return REAL_REFERENCES.find((ref) => `lib-${ref.id}` === entry.id) ?? null;
}

/** 详情页展示的 IPC：真实参考资料用扉页读出的完整分类号（读不出时为空），其余用条目自带的分类号；去重。 */
export function entryIpc(entry: LibraryEntry): string[] {
  const ref = referenceOf(entry);
  const codes = ref ? ref.ipc : entry.ipc;
  return [...new Set(codes.map((code) => code.trim()).filter(Boolean))];
}

/** 只返回知识库里已核实记录的公开地址，没有就返回空字符串。 */
export function referenceUrl(entry: LibraryEntry): string {
  return referenceOf(entry)?.url ?? "";
}

export function entryBadges(entry: LibraryEntry): Array<{ text: string; tone: "confirm" | "improve" | "severe" }> {
  if (entry.kind === "sample") return [{ text: "虚构示范", tone: "confirm" }, { text: "可导出 Word", tone: "improve" }];
  if (entry.kind === "reference") {
    const ref = referenceOf(entry);
    return [{ text: ref?.kind === "官方材料" ? "CNIPA 官方材料" : "真实授权专利 · 仅作结构参考", tone: "improve" }];
  }
  return [{ text: "领域撰写指引", tone: "improve" }];
}

export type ExportPlan = { ok: true; markdown: string; title: string; fileStem: string } | { ok: false; reason: string };

/** 只有虚构示范样例是完整申请文件结构，可以按申请文件格式导出 Word；其他条目给出原因。 */
export function exportPlan(entry: LibraryEntry | null): ExportPlan {
  if (!entry) return { ok: false, reason: "请先在左侧选择一个条目。" };
  if (entry.kind !== "sample") {
    return {
      ok: false,
      reason: entry.kind === "reference" ? "真实专利只作结构参考，不导出其内容；请打开公开文本查看。" : "领域指引不是申请文件，可以加入对话后由 /发明稿 参照撰写。",
    };
  }
  const sample = findSample(entry.id);
  if (!sample || !sample.markdown.trim()) return { ok: false, reason: "没有找到这个样例的申请文件正文。" };
  return { ok: true, markdown: sample.markdown, title: sample.title, fileStem: sample.title.replace(/（虚构示范）$/, "") };
}
