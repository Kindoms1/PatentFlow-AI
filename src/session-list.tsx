/**
 * 侧边栏会话列表：分组（置顶 / 今天 / 7 天 / 30 天 / 更早）、重命名、置顶、导出、清空对话、删除及撤销、清空全部。
 */
import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import type { PatentCase } from "./model.ts";
import { useStore } from "./store.tsx";
import { conversationMarkdown, groupSessions, lastActive, relativeTime } from "./session-utils.ts";
import { saveBlob, safeFileName } from "./download.ts";

interface SessionListProps {
  sessions: PatentCase[];
  total: number;
  activeId: string | null;
  busyId: string | null;
  filtering: boolean;
  listRef?: unknown;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
  onCleared: () => void;
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

function clip(text: string, cap = 14): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

export function SessionList({ sessions, total, activeId, busyId, filtering, listRef, onOpen, onDeleted, onCleared }: SessionListProps) {
  const { state, dispatch, notify } = useStore();
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [undo, setUndo] = useState<{ item: PatentCase; index: number; wasActive: boolean } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const undoTimer = useRef<number | undefined>(undefined);
  const clearTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(undoTimer.current);
      window.clearTimeout(clearTimer.current);
    },
    [],
  );

  // Close the item menu on an outside click or Esc.
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".session-menu") || target?.closest(".dsh-session-more")) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const startRename = (item: PatentCase) => {
    setMenu(null);
    setRenaming(item.id);
    setDraftTitle(item.title);
  };

  const commitRename = () => {
    const id = renaming;
    if (!id) return;
    const item = state.cases.find((patentCase) => patentCase.id === id);
    const title = draftTitle.replace(/\s+/g, " ").trim().slice(0, 60);
    setRenaming(null);
    if (item && title && title !== item.title) {
      dispatch({ type: "rename-case", caseId: id, title });
      notify("会话已重命名。");
    }
  };

  const remove = (item: PatentCase) => {
    setMenu(null);
    const index = state.cases.findIndex((patentCase) => patentCase.id === item.id);
    dispatch({ type: "delete-case", id: item.id });
    onDeleted(item.id);
    setUndo({ item, index: Math.max(0, index), wasActive: state.activeCaseId === item.id });
    window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), 7000);
  };

  const restore = () => {
    if (!undo) return;
    dispatch({ type: "restore-case", patentCase: undo.item, index: undo.index, activate: undo.wasActive });
    window.clearTimeout(undoTimer.current);
    setUndo(null);
    notify(`已恢复「${clip(undo.item.title, 20)}」。`);
  };

  const exportMarkdown = (item: PatentCase) => {
    setMenu(null);
    saveBlob(new Blob([conversationMarkdown(item)], { type: "text/markdown;charset=utf-8" }), `${safeFileName(item.title)}-对话记录.md`);
    notify("已导出对话记录（Markdown）。");
  };

  const clearChat = (item: PatentCase) => {
    setMenu(null);
    dispatch({ type: "clear-chat", caseId: item.id });
    notify("对话内容已清空，资料、记忆和已生成的申请文件都保留。");
  };

  const clearAll = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      window.clearTimeout(clearTimer.current);
      clearTimer.current = window.setTimeout(() => setConfirmClear(false), 4000);
      return;
    }
    window.clearTimeout(clearTimer.current);
    setConfirmClear(false);
    const count = state.cases.length;
    dispatch({ type: "clear-cases" });
    setUndo(null);
    onCleared();
    notify(`已清空 ${count} 个会话。`);
  };

  const groups = groupSessions(sessions, now);

  return (
    <>
      <ul className="dsh-session-list" ref={listRef as Ref<HTMLUListElement>}>
        {groups.flatMap((group) => [
          <li key={`group-${group.key}`} className="dsh-session-group" aria-hidden="true">
            {group.label}
          </li>,
          ...group.items.map((item) => {
            const active = activeId === item.id;
            const running = busyId === item.id;
            const turns = item.messages.filter((message) => message.role !== "trace").length;
            return (
              <li key={item.id} className={menu === item.id ? "dsh-session-row menu-open" : "dsh-session-row"}>
                {renaming === item.id ? (
                  <input
                    className="session-rename"
                    autoFocus
                    value={draftTitle}
                    maxLength={60}
                    aria-label="会话名称"
                    onChange={(event) => setDraftTitle(event.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitRename();
                      }
                      if (event.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className={active ? "dsh-session active" : "dsh-session"}
                    aria-current={active ? "page" : undefined}
                    title={`${item.title}（双击重命名）`}
                    onClick={() => onOpen(item.id)}
                    onDoubleClick={() => startRename(item)}
                  >
                    <b>{item.title}</b>
                    <small>
                      {running ? <i className="dsh-live" aria-label="正在回复" /> : null}
                      {item.demo ? <em className="dsh-demo-tag">示范</em> : null}
                      {turns} 条 · {relativeTime(lastActive(item), now)}
                      {item.inventionDraft?.text ? " · 已成稿" : ""}
                    </small>
                  </button>
                )}
                <button
                  type="button"
                  className="dsh-session-more"
                  aria-label={`更多操作：${item.title}`}
                  aria-haspopup="menu"
                  aria-expanded={menu === item.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenu((value) => (value === item.id ? null : item.id));
                  }}
                >
                  <MoreIcon />
                </button>
                {menu === item.id ? (
                  <div className="session-menu" role="menu" aria-label={`「${clip(item.title, 20)}」的操作`}>
                    <button type="button" role="menuitem" onClick={() => startRename(item)}>
                      重命名
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        dispatch({ type: "pin-case", caseId: item.id, pinned: !item.pinned });
                        setMenu(null);
                      }}
                    >
                      {item.pinned ? "取消置顶" : "置顶"}
                    </button>
                    <button type="button" role="menuitem" onClick={() => exportMarkdown(item)}>
                      导出对话记录
                    </button>
                    <button type="button" role="menuitem" disabled={turns === 0 || running} onClick={() => clearChat(item)}>
                      清空对话内容
                    </button>
                    <button type="button" role="menuitem" className="danger" onClick={() => remove(item)}>
                      删除会话
                    </button>
                  </div>
                ) : null}
              </li>
            );
          }),
        ])}
      </ul>
      {undo ? (
        <div className="session-undo" role="status">
          <span>已删除「{clip(undo.item.title)}」</span>
          <button type="button" onClick={restore}>
            撤销
          </button>
        </div>
      ) : null}
      {total > 1 && !filtering ? (
        <button type="button" className={confirmClear ? "session-clear armed" : "session-clear"} title="删除全部会话及其资料，清空后无法撤销" aria-live="polite" onClick={clearAll}>
          {confirmClear ? `再点一次，清空全部 ${total} 个会话` : "清空全部会话"}
        </button>
      ) : null}
    </>
  );
}
