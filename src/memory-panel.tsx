/** 右侧「上下文与记忆」面板：上下文用量估算、案件记忆的增删改、资料清单。 */
import { useMemo, useState } from "react";
import type { PatentCase } from "./model.ts";
import { estimateTokens } from "./context-budget.ts";
import { FORMAT_LABEL, detectFormat } from "./read-user-file.ts";
import { useStore } from "./store.tsx";
import { sizeLabel } from "./page-count.ts";

/** Per-turn caps the prompt builder applies (see skill-turn / context-budget). */
const MATERIAL_CAP = 12_000;
const DIALOG_CAP = 9_000;
const WINDOW = 128_000;

function fmt(value: number): string {
  return value >= 10_000 ? `${(value / 10_000).toFixed(1)} 万` : String(value);
}

export function MemoryPanel({ patentCase }: { patentCase: PatentCase }) {
  const { dispatch, notify } = useStore();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const memory = useMemo(() => patentCase.memory ?? [], [patentCase.memory]);
  const confirmed = patentCase.facts.filter((fact) => fact.status === "confirmed");
  const unimported = confirmed.filter((fact) => !memory.some((note) => note.text === fact.statement.trim()));

  const usage = useMemo(() => {
    const materials = patentCase.materials.reduce((sum, item) => sum + estimateTokens(item.text), 0);
    const dialog = patentCase.messages.filter((item) => item.role !== "trace").reduce((sum, item) => sum + estimateTokens(item.text), 0);
    const notes = memory.reduce((sum, note) => sum + estimateTokens(note.text), 0);
    const sent = Math.min(materials, MATERIAL_CAP) + Math.min(dialog, DIALOG_CAP) + notes + 2500;
    return { materials, dialog, notes, sent };
  }, [patentCase.materials, patentCase.messages, memory]);

  const add = () => {
    const value = text.trim();
    if (!value) return;
    dispatch({ type: "add-memory", caseId: patentCase.id, text: value, source: "user" });
    setText("");
  };

  const share = (value: number) => `${Math.max(2, Math.min(100, Math.round((value / WINDOW) * 100)))}%`;

  return (
    <div className="mem-panel">
      <section>
        <h3>上下文用量（估算）</h3>
        <div className="ctx-bar" role="img" aria-label={`每轮约发送 ${usage.sent} tokens`}>
          <i className="ctx-material" style={{ width: share(Math.min(usage.materials, MATERIAL_CAP)) }} />
          <i className="ctx-dialog" style={{ width: share(Math.min(usage.dialog, DIALOG_CAP)) }} />
          <i className="ctx-memory" style={{ width: share(usage.notes + 2500) }} />
        </div>
        <ul className="ctx-legend">
          <li><i className="ctx-material" />资料 {fmt(usage.materials)} tokens{usage.materials > MATERIAL_CAP ? "，每轮按问题相关度节选" : ""}</li>
          <li><i className="ctx-dialog" />对话 {fmt(usage.dialog)} tokens{usage.dialog > DIALOG_CAP ? "，较早的对话自动压缩成摘要" : ""}</li>
          <li><i className="ctx-memory" />记忆与运行环境 {fmt(usage.notes + 2500)} tokens，每轮全量注入</li>
        </ul>
        <p className="fine">每轮大约发送 {fmt(usage.sent)} tokens。撰写发明稿时，资料上限会放宽到约 3 万字。</p>
      </section>

      <section>
        <h3>案件记忆（{memory.length}）</h3>
        <p className="fine">这里的要点每一轮都会告诉模型，并作为已确认事实写入发明稿。适合记录术语约定、关键参数、保护重点和要避开的写法。</p>
        <div className="mem-add">
          <textarea
            value={text}
            rows={2}
            maxLength={600}
            placeholder="例如：“刮板”统一称为“清污刮板”；重点保护叶轮驱动结构"
            aria-label="新增案件记忆"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="btn primary" disabled={!text.trim()} onClick={add}>
            记住
          </button>
        </div>
        {unimported.length > 0 ? (
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              unimported.forEach((fact) => dispatch({ type: "add-memory", caseId: patentCase.id, text: fact.statement, source: "user" }));
              notify(`已把 ${unimported.length} 条已确认事实加入记忆。`);
            }}
          >
            导入已确认的事实（{unimported.length}）
          </button>
        ) : null}
        {memory.length === 0 ? <p className="empty-copy">还没有记忆。可以在这里输入，或点对话里自己消息旁的「记住」。</p> : null}
        <ul className="mem-list">
          {memory.map((note) => (
            <li key={note.id}>
              {editing === note.id ? (
                <>
                  <textarea value={editText} rows={3} maxLength={600} aria-label="编辑记忆" onChange={(event) => setEditText(event.target.value)} />
                  <div className="mem-actions">
                    <button
                      type="button"
                      onClick={() => {
                        dispatch({ type: "update-memory", caseId: patentCase.id, id: note.id, text: editText });
                        setEditing(null);
                      }}
                    >
                      保存
                    </button>
                    <button type="button" onClick={() => setEditing(null)}>
                      取消
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>{note.text}</p>
                  <div className="mem-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(note.id);
                        setEditText(note.text);
                      }}
                    >
                      编辑
                    </button>
                    <button type="button" className="danger" onClick={() => dispatch({ type: "remove-memory", caseId: patentCase.id, id: note.id })}>
                      删除
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>资料（{patentCase.materials.length}）</h3>
        {patentCase.materials.length === 0 ? <p className="empty-copy">还没有资料。把 PDF、Word、PPT、Excel、图片等文件拖到输入框即可。</p> : null}
        <ul className="mem-files">
          {patentCase.materials.map((item) => {
            const format = detectFormat(item.name);
            return (
              <li key={item.id}>
                <span className="pkg-badge">{format ? FORMAT_LABEL[format] : item.kind === "pdf" ? "PDF" : "文本"}</span>
                <b title={item.name}>{item.name}</b>
                <small>{sizeLabel(item)}</small>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
