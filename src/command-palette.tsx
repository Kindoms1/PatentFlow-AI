import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { buildPaletteView, groupOf, highlight, isCurrent, searchTerms, shortcutOf, type PaletteCommand, type PaletteGroup } from "./palette-search.ts";

export type { PaletteCommand, PaletteGroup } from "./palette-search.ts";

interface CommandPaletteProps {
  commands: PaletteCommand[];
  onClose: () => void;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const GROUP_ICON: Record<PaletteGroup, ReactNode> = {
  action: (
    <Icon>
      <path d="M11 2.5 4.5 11h5l-1 6.5L15.5 9h-5l.5-6.5Z" />
    </Icon>
  ),
  page: (
    <Icon>
      <rect x="3" y="3.5" width="14" height="13" rx="2" />
      <path d="M3 7.5h14M7.5 7.5v9" />
    </Icon>
  ),
  panel: (
    <Icon>
      <rect x="3" y="3.5" width="14" height="13" rx="2" />
      <path d="M12.5 3.5v13" />
    </Icon>
  ),
  session: (
    <Icon>
      <path d="M4 5.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3H6a2 2 0 0 1-2-2v-6Z" />
    </Icon>
  ),
};

const SEARCH_ICON = (
  <Icon>
    <circle cx="9" cy="9" r="5.5" />
    <path d="m13.2 13.2 3.3 3.3" />
  </Icon>
);

const CLEAR_ICON = (
  <Icon>
    <path d="m6 6 8 8M14 6l-8 8" />
  </Icon>
);

function Marked({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlight(text, terms).map((part, index) => (part.hit ? <mark key={index}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>))}
    </>
  );
}

/**
 * Ctrl/Cmd+K command palette (combobox + grouped listbox).
 * Results are grouped (动作 / 页面 / 案件面板 / 会话) and ranked by relevance with matches highlighted.
 * Arrow keys or Tab move the selection, Enter runs it, Esc, the Esc key cap or a click outside closes,
 * IME composition is never intercepted, and focus returns to where it was on close.
 */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const terms = useMemo(() => searchTerms(query), [query]);
  const { sections, flat, hiddenSessions } = useMemo(() => buildPaletteView(commands, query), [commands, query]);
  const active = flat.length ? Math.min(cursor, flat.length - 1) : -1;
  const optionId = (index: number) => `${listId}-opt-${index}`;
  const activeId = active >= 0 ? optionId(active) : undefined;
  const searching = terms.length > 0;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const choose = (command: PaletteCommand) => {
    onClose();
    command.run();
  };

  const move = (delta: number) => {
    if (!flat.length) return;
    setCursor((active + delta + flat.length) % flat.length);
  };

  const updateQuery = (value: string) => {
    setQuery(value);
    setCursor(0);
  };

  return (
    <div
      className="palette-layer"
      onMouseDown={(event) => {
        // Keep the browser from moving focus to <body> after the close has already restored it.
        event.preventDefault();
        onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-head">
          <span className="palette-search-icon">{SEARCH_ICON}</span>
          <input
            ref={inputRef}
            value={query}
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            aria-label="搜索命令、页面或会话"
            placeholder="搜索命令、页面或会话…"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
                event.preventDefault();
                move(-1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (active >= 0) choose(flat[active]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className="palette-clear"
              aria-label="清空搜索"
              title="清空搜索"
              onClick={() => {
                updateQuery("");
                inputRef.current?.focus();
              }}
            >
              {CLEAR_ICON}
            </button>
          ) : null}
          <button type="button" className="palette-esc" aria-label="关闭命令面板" title="关闭（Esc）" onClick={onClose}>
            <kbd>Esc</kbd>
          </button>
        </div>

        <div className="palette-list" id={listId} role="listbox" aria-label="命令与结果" hidden={flat.length === 0}>
          {sections.map((section) => {
            const headingId = `${listId}-grp-${section.group}`;
            return (
              <div key={section.group} className="palette-group" role="group" aria-labelledby={headingId}>
                <div className="palette-group-label" id={headingId} role="presentation">
                  {section.label}
                  <span className="palette-group-count">{section.entries.length}</span>
                </div>
                {section.entries.map(({ command, index }) => {
                  const group = groupOf(command);
                  const current = isCurrent(command);
                  const shortcut = shortcutOf(command);
                  const selected = index === active;
                  return (
                    <button
                      key={command.id}
                      id={optionId(index)}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={selected}
                      title={command.detail ? `${command.label} · ${command.detail}` : command.label}
                      className={`palette-option${selected ? " active" : ""}${current ? " current" : ""}`}
                      onMouseMove={() => {
                        if (!selected) setCursor(index);
                      }}
                      onClick={() => choose(command)}
                    >
                      <span className={`palette-icon palette-icon-${group}`}>{GROUP_ICON[group]}</span>
                      <span className="palette-text">
                        <span className="palette-label">
                          <Marked text={command.label} terms={terms} />
                        </span>
                        {command.detail ? (
                          <span className="palette-detail">
                            <Marked text={command.detail} terms={terms} />
                          </span>
                        ) : null}
                      </span>
                      {current ? <span className="palette-badge">当前</span> : shortcut ? <kbd className="palette-key">{shortcut}</kbd> : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {!searching && hiddenSessions > 0 ? <p className="palette-more" role="presentation">还有 {hiddenSessions} 个会话，输入标题里的词即可找到</p> : null}
        </div>

        {flat.length === 0 ? (
          <div className="palette-empty" role="status">
            <span className="palette-empty-icon">{SEARCH_ICON}</span>
            <strong>{searching ? `没有找到“${query.trim()}”` : "暂无可用命令"}</strong>
            {searching ? <span>试试“新对话”“设置”“技术雷达”，或会话标题里的词</span> : null}
          </div>
        ) : null}
        {searching && flat.length > 0 ? (
          <p className="sr-only" role="status">
            找到 {flat.length} 条结果
          </p>
        ) : null}

        <footer className="palette-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>Enter</kbd> 执行
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
          <span className="palette-foot-count">{searching ? `${flat.length} 条结果` : "输入关键词筛选"}</span>
        </footer>
      </div>
    </div>
  );
}