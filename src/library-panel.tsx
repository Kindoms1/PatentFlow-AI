import { useMemo, useState } from "react";
import type * as ExportDocx from "./export-docx.ts";
import {
  EMPTY_LIBRARY_QUERY,
  KIND_OPTIONS,
  LIBRARY_DISCLAIMER,
  domainOptions,
  entryBadges,
  entryIpc,
  exportPlan,
  ipcOptions,
  isFiltered,
  kindLabel,
  libraryView,
  pickEntry,
  referenceUrl,
} from "./library-view.ts";
import type { LibraryKindFilter, LibraryQuery } from "./library-view.ts";

// Load docx only when a sample is actually exported.
const downloadApplication: typeof ExportDocx.downloadApplication = async (...args) => (await import("./export-docx.ts")).downloadApplication(...args);


/**
 * 知识库中的「专利分类与样例」：按技术领域、IPC、类型和关键词筛选领域指引、虚构示范样例和真实参考资料，
 * 预览全文，把条目加入当前对话，虚构示范样例可按申请文件格式下载 Word。
 * 渲染为知识库三栏布局中的后两栏（列表 + 详情）。
 */
export function LibraryPanel({ onLoad, notify }: { onLoad: (ids: string[]) => void; notify: (text: string) => void }) {
  const [query, setQuery] = useState<LibraryQuery>(EMPTY_LIBRARY_QUERY);
  const [selectedId, setSelectedId] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const domains = useMemo(() => domainOptions(), []);
  const ipcs = useMemo(() => ipcOptions(query.domainId), [query.domainId]);
  const view = useMemo(() => libraryView(query), [query]);
  const selected = pickEntry(view.entries, selectedId);
  const plan = exportPlan(selected);
  const url = selected ? referenceUrl(selected) : "";
  const ipcList = selected ? entryIpc(selected) : [];

  const update = (patch: Partial<LibraryQuery>) => {
    setQuery((current) => ({ ...current, ...patch }));
    setExportError("");
  };

  const select = (id: string) => {
    setSelectedId(id);
    setExportError("");
  };

  const download = async () => {
    if (!plan.ok || exporting) return;
    setExporting(true);
    setExportError("");
    try {
      await downloadApplication(plan.markdown, plan.title, { sample: true, fileStem: plan.fileStem });
      notify(`已导出 Word：${plan.title}。样例为虚构内容，仅用于学习格式。`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setExportError(`导出失败：${reason}`);
      notify("Word 导出失败，详情见右侧提示。");
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <section className="library-list" aria-label="专利分类与样例列表">
        <div className="library-filters">
          <input
            type="search"
            value={query.query}
            placeholder="搜索标题、IPC 或正文，空格分隔多个词"
            aria-label="搜索知识库"
            onChange={(event) => update({ query: event.target.value })}
          />
          <div className="library-row">
            <select aria-label="技术领域" value={query.domainId} onChange={(event) => update({ domainId: event.target.value, ipc: "" })}>
              {domains.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
            <input
              list="library-ipc-options"
              value={query.ipc}
              placeholder="IPC，如 G06T、A61B 5/"
              aria-label="IPC 分类号前缀"
              onChange={(event) => update({ ipc: event.target.value })}
            />
            <datalist id="library-ipc-options">
              {ipcs.map((item) => (
                <option key={item.code} value={item.code}>{item.label}</option>
              ))}
            </datalist>
          </div>
          <div className="library-kinds" role="group" aria-label="条目类型">
            {KIND_OPTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={query.kind === item.id ? "chip active" : "chip"}
                aria-pressed={query.kind === item.id}
                onClick={() => update({ kind: item.id as LibraryKindFilter })}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {view.ok ? (
          <p className="library-count">
            {isFiltered(query) ? `筛选出 ${view.entries.length} / ${view.total} 条` : `共 ${view.total} 条`}
            {isFiltered(query) ? (
              <button type="button" className="text-btn" onClick={() => update(EMPTY_LIBRARY_QUERY)}>清除筛选</button>
            ) : null}
          </p>
        ) : (
          <p className="library-error" role="alert">知识库读取失败：{view.error}</p>
        )}

        {view.ok && view.entries.length === 0 ? (
          <p className="empty-copy">没有匹配的条目。可以换个关键词、放宽 IPC 前缀，或清除筛选。</p>
        ) : null}

        {view.entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={selected?.id === entry.id ? "result selected" : "result"}
            onClick={() => select(entry.id)}
          >
            <strong>{entry.title}</strong>
            <span>{entry.subtitle}</span>
          </button>
        ))}
      </section>

      <section className="library-detail" aria-label="条目详情">
        {selected ? (
          <>
            <p className="library-meta">
              {entryBadges(selected).map((badge) => (
                <span key={badge.text} className={`mark mark-${badge.tone}`}>{badge.text}</span>
              ))}
              <span className="fine">{kindLabel(selected.kind)}</span>
            </p>
            <h1>{selected.title}</h1>
            <p className="library-meta">
              {ipcList.length ? (
                ipcList.map((code) => <span key={code} className="library-ipc">{code}</span>)
              ) : (
                <span className="fine">IPC：未从资料中读出，留空（以公告文本为准）</span>
              )}
            </p>
            <div className="library-actions">
              <button className="btn primary" type="button" onClick={() => onLoad([selected.id])}>加入当前对话</button>
              <button
                className="btn ghost"
                type="button"
                disabled={!plan.ok || exporting}
                aria-busy={exporting}
                title={plan.ok ? "按申请文件格式导出 Word" : plan.reason}
                onClick={() => void download()}
              >
                {exporting ? "正在生成 Word…" : "下载 Word"}
              </button>
              {url ? (
                <a className="btn ghost library-link" href={url} target="_blank" rel="noreferrer">打开公开文本</a>
              ) : null}
            </div>
            {!plan.ok ? <p className="fine">{plan.reason}</p> : null}
            {exportError ? <p className="library-error" role="alert">{exportError}</p> : null}
            <pre className="knowledge-text">{selected.text}</pre>
            <p className="fine library-disclaimer">{LIBRARY_DISCLAIMER}</p>
          </>
        ) : (
          <p className="empty-copy">{view.ok ? "选择左侧条目查看全文。" : "知识库暂时无法读取。"}</p>
        )}
      </section>
    </>
  );
}
