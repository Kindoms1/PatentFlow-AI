/** Pure helpers for the conversation list: activity time, grouping, relative time and Markdown export. */
import type { PatentCase } from "./model.ts";

const DAY = 86_400_000;

interface Activity {
  createdAt: string;
  messages: ReadonlyArray<{ at: string }>;
  inventionDraft?: { at: string };
  pinned?: boolean;
}

export function lastActive(item: Activity): number {
  const stamps = [item.createdAt, item.messages.at(-1)?.at, item.inventionDraft?.at]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  return stamps.length ? Math.max(...stamps) : 0;
}

export interface SessionGroup<T> {
  key: "pinned" | "today" | "week" | "month" | "older";
  label: string;
  items: T[];
}

export function groupSessions<T extends Activity>(items: T[], now = Date.now()): Array<SessionGroup<T>> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const groups: Array<SessionGroup<T>> = [
    { key: "pinned", label: "置顶", items: [] },
    { key: "today", label: "今天", items: [] },
    { key: "week", label: "最近 7 天", items: [] },
    { key: "month", label: "最近 30 天", items: [] },
    { key: "older", label: "更早", items: [] },
  ];
  for (const item of [...items].sort((a, b) => lastActive(b) - lastActive(a))) {
    const time = lastActive(item);
    const slot = item.pinned ? 0 : time >= today ? 1 : time >= today - 6 * DAY ? 2 : time >= today - 29 * DAY ? 3 : 4;
    groups[slot].items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}

export function relativeTime(time: number, now = Date.now()): string {
  if (!time) return "";
  const diff = now - time;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const date = new Date(time);
  const current = new Date(now);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (time >= midnight.getTime()) return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (time >= midnight.getTime() - DAY) return "昨天";
  if (time >= midnight.getTime() - 6 * DAY) return `${Math.ceil((midnight.getTime() - time) / DAY)} 天前`;
  if (date.getFullYear() === current.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function stampText(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(time));
}

/** The whole conversation as Markdown, for “导出对话记录”. */
export function conversationMarkdown(item: PatentCase, now = new Date()): string {
  const dialog = item.messages.filter((message) => message.role !== "trace");
  const lines: string[] = [`# ${item.title}`, "", `> 导出时间：${stampText(now.toISOString())}（北京时间） · ${dialog.length} 条对话`, ""];
  if (item.materials?.length) lines.push("## 资料", "", ...item.materials.map((material) => `- 《${material.name}》（${material.chars} 字）`), "");
  if (item.memory?.length) lines.push("## 案件记忆", "", ...item.memory.map((note) => `- ${note.text}`), "");
  lines.push("## 对话", "");
  for (const message of item.messages) {
    if (message.role === "trace") {
      lines.push(`> 过程：${message.text.replace(/\s*\n+\s*/g, " ")}`, "");
      continue;
    }
    lines.push(`### ${message.role === "user" ? "我" : "PatentFlow"} · ${stampText(message.at)}`, "", message.text.trim(), "");
    if (message.attachments?.length) lines.push(`附件：${message.attachments.map((file) => `《${file.name}》`).join("、")}`, "");
  }
  if (item.inventionDraft?.text) lines.push("---", "", "## 发明专利申请文件草稿", "", item.inventionDraft.text.trim(), "");
  return lines.join("\n");
}
