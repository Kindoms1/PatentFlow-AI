import { useEffect, useMemo, useRef, useState } from "react";
import { activeCase } from "./model.ts";
import type { View } from "./model.ts";
import { useStore } from "./store.tsx";
import { Icon } from "./widgets.tsx";
import { AnalysisPage, CasesPage, KnowledgePage, ModelsPage, RadarPage, SearchPage, SettingsPage, SkillsPage, TasksPage } from "./pages.tsx";
import { Workbench } from "./workbench.tsx";
import { CaseView } from "./case-view.tsx";
import { useRadarAutoRun } from "./radar-client.ts";

const GROUPS: Array<{ label: string; items: Array<{ view: View; label: string; icon: string }> }> = [
  {
    label: "工作",
    items: [
      { view: "workbench", label: "工作台", icon: "workbench" },
      { view: "cases", label: "我的专利", icon: "cases" },
    ],
  },
  {
    label: "知识",
    items: [
      { view: "knowledge", label: "专利知识库", icon: "knowledge" },
      { view: "radar", label: "技术雷达", icon: "radar" },
      { view: "search", label: "专利检索", icon: "search" },
      { view: "analysis", label: "技术分析", icon: "analysis" },
    ],
  },
  {
    label: "系统",
    items: [
      { view: "skills", label: "Skills", icon: "skills" },
      { view: "models", label: "模型与工具", icon: "models" },
      { view: "tasks", label: "任务中心", icon: "tasks" },
      { view: "settings", label: "设置与安全", icon: "settings" },
    ],
  },
];

export function Shell() {
  useRadarAutoRun();
  const { state, view, setView, dispatch, toast } = useStore();
  const [openNav, setOpenNav] = useState(false);
  const [palette, setPalette] = useState(false);
  const [notices, setNotices] = useState(false);
  const current = activeCase(state);
  const pending = state.cases.reduce((sum, patentCase) => sum + patentCase.facts.filter((fact) => fact.status === "pending" && fact.origin !== "inference").length, 0);
  const proposals = state.cases.reduce((sum, patentCase) => sum + patentCase.proposals.filter((item) => item.status === "open").length, 0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const title = view === "case" ? current?.title ?? "案件" : GROUPS.flatMap((group) => group.items).find((item) => item.view === view)?.label ?? "PatentFlow";

  return (
    <div className="shell">
      <div className="ribbon" />
      {openNav ? <button className="scrim" type="button" aria-label="关闭导航" onClick={() => setOpenNav(false)} /> : null}
      <aside className={openNav ? "sidebar open" : "sidebar"}>
        <div className="brand brand-compact">
          <img src="/brand-logo.png" alt="PatentFlow AI" className="brand-logo" />
        </div>
        <button className="new-chat" type="button" onClick={() => { setView("workbench"); setOpenNav(false); }}>
          新对话
        </button>
        <div className="session-list">
          {state.cases.map((item) => (
            <button
              key={item.id}
              type="button"
              className={view === "case" && state.activeCaseId === item.id ? "session-btn active" : "session-btn"}
              onClick={() => {
                dispatch({ type: "open-case", id: item.id });
                setOpenNav(false);
              }}
            >
              <strong>{item.title}</strong>
              <small>{item.demo ? "示范" : "对话"}</small>
            </button>
          ))}
        </div>
        <div className="side-tools">
          <button type="button" className={view === "search" ? "active" : undefined} onClick={() => setView("search")}>检索</button>
          <button type="button" className={view === "knowledge" ? "active" : undefined} onClick={() => setView("knowledge")}>知识库</button>
          <button type="button" className={view === "radar" ? "active" : undefined} onClick={() => setView("radar")}>雷达</button>
          <button type="button" className={view === "models" ? "active" : undefined} onClick={() => setView("models")}>导入</button>
          <button type="button" className={view === "settings" ? "active" : undefined} onClick={() => setView("settings")}>设置</button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button className="icon-btn menu-btn" type="button" aria-label="打开导航" onClick={() => setOpenNav(true)}>
            <Icon name="workbench" />
          </button>
          <div className="top-title">
            <span>PatentFlow</span>
            <strong>{title}</strong>
          </div>
          <button className="search-launch slim-search" type="button" onClick={() => setPalette(true)}>
            <Icon name="search" />
            搜索
            <kbd>Ctrl K</kbd>
          </button>
          <div className="notice-wrap">
            <button className="icon-btn" type="button" aria-label="通知" onClick={() => setNotices((value) => !value)}>
              <Icon name="bell" />
              {pending + proposals > 0 ? <i>{pending + proposals}</i> : null}
            </button>
            {notices ? (
              <div className="notice-pop">
                <strong>待处理</strong>
                <p>{pending > 0 ? `${pending} 条来源事实还没有确认。` : "来源事实都已处理。"}</p>
                <p>{proposals > 0 ? `${proposals} 条修改提案等待接受或拒绝。` : "没有待决修改提案。"}</p>
                <p>专利数据源尚未授权，技术雷达不会出现同步完成的数字。</p>
              </div>
            ) : null}
          </div>
        </header>
        <main className="stage">
          {view === "workbench" ? <Workbench /> : null}
          {view === "cases" ? <CasesPage /> : null}
          {view === "case" ? <CaseView /> : null}
          {view === "knowledge" ? <KnowledgePage /> : null}
          {view === "radar" ? <RadarPage /> : null}
          {view === "search" ? <SearchPage /> : null}
          {view === "analysis" ? <AnalysisPage /> : null}
          {view === "skills" ? <SkillsPage /> : null}
          {view === "models" ? <ModelsPage /> : null}
          {view === "tasks" ? <TasksPage /> : null}
          {view === "settings" ? <SettingsPage /> : null}
        </main>
      </div>
      {palette ? <Palette onClose={() => setPalette(false)} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const { state, dispatch, setView } = useStore();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const current = activeCase(state);

  const commands = useMemo(() => {
    const pages = GROUPS.flatMap((group) => group.items).map((item) => ({
      id: item.view,
      label: `打开${item.label}`,
      hint: "页面",
      run: () => setView(item.view),
    }));
    const cases = state.cases.map((patentCase) => ({
      id: patentCase.id,
      label: `打开案件 · ${patentCase.title}`,
      hint: "案件",
      run: () => dispatch({ type: "open-case", id: patentCase.id }),
    }));
    const actions = current
      ? [
          { id: "confirm", label: "确认当前案件的全部来源事实", hint: "动作", run: () => dispatch({ type: "confirm-source", caseId: current.id }) },
          { id: "draft", label: "按已确认事实生成交底草稿", hint: "动作", run: () => { dispatch({ type: "generate", caseId: current.id }); setView("case"); } },
          { id: "chart", label: "查看当前案件的特征对照", hint: "动作", run: () => { dispatch({ type: "set-dock", tab: "chart" }); setView("case"); } },
        ]
      : [];
    return [...actions, ...cases, ...pages].filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()));
  }, [current, dispatch, query, setView, state.cases]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="palette-layer" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          placeholder="搜索案件、知识库、检索或生成草稿"
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((value) => Math.min(commands.length - 1, value + 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((value) => Math.max(0, value - 1));
            }
            if (event.key === "Enter" && commands[cursor]) {
              commands[cursor].run();
              onClose();
            }
          }}
        />
        <ul>
          {commands.length === 0 ? <li className="palette-empty">没有匹配的动作</li> : null}
          {commands.map((command, index) => (
            <li key={command.id}>
              <button
                type="button"
                className={index === cursor ? "active" : undefined}
                onMouseEnter={() => setCursor(index)}
                onClick={() => {
                  command.run();
                  onClose();
                }}
              >
                <span>{command.label}</span>
                <small>{command.hint}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
