/**
 * Search, ranking and grouping for the Ctrl/Cmd+K command palette. Pure functions without React,
 * so the behaviour is unit-tested on its own.
 */

export type PaletteGroup = "action" | "page" | "panel" | "session";

/** One runnable entry in the command palette. */
export interface PaletteCommand {
  id: string;
  label: string;
  /** Category or shortcut, e.g. 页面 / 会话 / Ctrl+B / "/". Category words become the group heading instead. */
  hint: string;
  /** Extra search terms that are matched but never shown. */
  keywords?: string;
  /** Section the command is listed under; derived from `hint` when omitted. */
  group?: PaletteGroup;
  /** Secondary line under the label (for example the case title); matched and highlighted. */
  detail?: string;
  /** Marks the session that is open right now. */
  current?: boolean;
  run: () => void;
}

export interface PaletteEntry {
  command: PaletteCommand;
  /** Position in `PaletteView.flat`, i.e. the keyboard order. */
  index: number;
}

export interface PaletteSection {
  group: PaletteGroup;
  label: string;
  entries: PaletteEntry[];
}

export interface PaletteView {
  sections: PaletteSection[];
  /** Every visible command in display order; arrow keys walk this list. */
  flat: PaletteCommand[];
  /** Sessions left out of the idle list (they are all searchable). */
  hiddenSessions: number;
}

export interface MarkedPart {
  text: string;
  hit: boolean;
}

export const GROUP_ORDER: readonly PaletteGroup[] = ["action", "page", "panel", "session"];

export const GROUP_LABEL: Record<PaletteGroup, string> = {
  action: "动作",
  page: "页面",
  panel: "案件面板",
  session: "会话",
};

const CATEGORY_HINTS = new Set(["动作", "页面", "面板", "会话", "当前会话"]);

export function groupOf(command: PaletteCommand): PaletteGroup {
  if (command.group) return command.group;
  if (command.hint === "页面") return "page";
  if (command.hint === "面板") return "panel";
  if (command.hint === "会话" || command.hint === "当前会话") return "session";
  return "action";
}

/** A hint worth showing as a key cap (Ctrl+B, /); category words are already the group heading. */
export function shortcutOf(command: PaletteCommand): string | null {
  const hint = command.hint.trim();
  return hint && !CATEGORY_HINTS.has(hint) ? hint : null;
}

export function isCurrent(command: PaletteCommand): boolean {
  return Boolean(command.current) || command.hint === "当前会话";
}

export function searchTerms(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
}

/**
 * 0 when any term is missing. Otherwise higher is better: a label that starts with the term beats one that
 * contains it, which beats a match in the detail line, which beats a match in hidden keywords.
 */
export function scoreCommand(command: PaletteCommand, terms: readonly string[]): number {
  if (!terms.length) return 1;
  const label = command.label.toLowerCase();
  const detail = (command.detail ?? "").toLowerCase();
  const extra = `${command.hint} ${command.keywords ?? ""}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (label.startsWith(term)) score += 30;
    else if (label.includes(term)) score += 20;
    else if (detail.includes(term)) score += 10;
    else if (extra.includes(term)) score += 4;
    else return 0;
  }
  if (label === terms.join(" ")) score += 50;
  return score;
}

interface Ranked {
  command: PaletteCommand;
  order: number;
  score: number;
}

/**
 * Groups the matching commands. Without a query the groups keep their fixed order and the session list is
 * capped (the open session always stays visible). With a query every match is listed, best first inside each
 * group, and the group holding the best match comes first so Enter runs the top hit.
 */
export function buildPaletteView(commands: readonly PaletteCommand[], query: string, sessionLimit = 8): PaletteView {
  const terms = searchTerms(query);
  const buckets = new Map<PaletteGroup, Ranked[]>();
  commands.forEach((command, order) => {
    const score = scoreCommand(command, terms);
    if (score <= 0) return;
    const group = groupOf(command);
    const list = buckets.get(group) ?? [];
    list.push({ command, order, score });
    buckets.set(group, list);
  });

  let hiddenSessions = 0;
  const groups = GROUP_ORDER.filter((group) => (buckets.get(group) ?? []).length > 0).map((group) => {
    let list = buckets.get(group) ?? [];
    if (terms.length) {
      list = [...list].sort((a, b) => b.score - a.score || a.order - b.order);
    } else if (group === "session" && sessionLimit > 0 && list.length > sessionLimit) {
      const shown = list.slice(0, sessionLimit);
      const open = list.find((item) => isCurrent(item.command));
      if (open && !shown.includes(open)) shown[shown.length - 1] = open;
      hiddenSessions = list.length - shown.length;
      list = shown.sort((a, b) => a.order - b.order);
    }
    return { group, list, best: list.reduce((max, item) => Math.max(max, item.score), 0) };
  });
  if (terms.length) {
    groups.sort((a, b) => b.best - a.best || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }

  const flat: PaletteCommand[] = [];
  const sections = groups.map(({ group, list }) => ({
    group,
    label: GROUP_LABEL[group],
    entries: list.map((item) => {
      flat.push(item.command);
      return { command: item.command, index: flat.length - 1 };
    }),
  }));
  return { sections, flat, hiddenSessions };
}

/** Splits `text` into plain and matched parts (case-insensitive, overlapping matches merged). */
export function highlight(text: string, terms: readonly string[]): MarkedPart[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  if (!terms.length || lower.length !== text.length) return [{ text, hit: false }];
  const marks = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    if (!term) continue;
    let from = lower.indexOf(term);
    while (from !== -1) {
      for (let i = from; i < from + term.length; i += 1) marks[i] = true;
      from = lower.indexOf(term, from + term.length);
    }
  }
  const parts: MarkedPart[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i += 1) {
    if (i === text.length || marks[i] !== marks[start]) {
      parts.push({ text: text.slice(start, i), hit: marks[start] });
      start = i;
    }
  }
  return parts;
}