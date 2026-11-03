import { useMemo, useState } from "react";
import { useListMotion } from "./fx.tsx";
import type { Subscription } from "./model.ts";
import { radarDue, runSubscription, runSubscriptionReport, useRadarRunning } from "./radar-client.ts";
import { summarizeRadarRun, type RadarRunReport } from "./radar-summary.ts";
import { useStore } from "./store.tsx";
import { formatTime } from "./widgets.tsx";
import { radarSavedNotice } from './radar-schedule.ts';

const SCHEDULE_LABEL: Record<Subscription["schedule"], string> = { daily: "每日", weekly: "每周", manual: "手动" };

function kindClass(pn: string): string {
  if (/[UY]\d?$/.test(pn)) return "u";
  if (/[BC]\d?$/.test(pn)) return "b";
  return "a";
}

const PRESETS: Array<{ name: string; keywords: string; ipc: string }> = [
  { name: "遥感建筑物分割", keywords: "遥感，建筑物提取，边界细化", ipc: "G06V" },
  { name: "大模型检索增强", keywords: "大语言模型，检索增强生成，知识库", ipc: "G06F" },
  { name: "锂电池热管理", keywords: "锂电池，热管理，液冷", ipc: "H01M" },
];

const IPC_SECTIONS: Array<[string, string]> = [
  ["A", "人类生活必需"],
  ["B", "作业；运输"],
  ["C", "化学；冶金"],
  ["D", "纺织；造纸"],
  ["E", "固定建筑物"],
  ["F", "机械工程；照明；加热；武器；爆破"],
  ["G", "物理（计算、测量、光学等）"],
  ["H", "电学（电池、通信、电路等）"],
];

const IPC_COMMON: Array<{ code: string; label: string }> = [
  { code: "G06F", label: "电数字数据处理（软件、数据库、人机交互）" },
  { code: "G06N", label: "基于特定计算模型的计算机系统（机器学习、神经网络）" },
  { code: "G06V", label: "图像或视频识别与理解" },
  { code: "G06T", label: "一般的图像数据处理" },
  { code: "H04L", label: "数字信息的传输（网络、通信协议）" },
  { code: "H01M", label: "化学能转为电能的装置（电池）" },
  { code: "A61B", label: "诊断；外科；鉴定" },
  { code: "B60L", label: "电动车辆动力装置与供电" },
];

function IpcGuide({ value, onPick }: { value: string; onPick: (code: string) => void }) {
  return (
    <details className="ipc-guide">
      <summary>IPC 分类号是什么？怎么填？</summary>
      <p>
        IPC（International Patent Classification，国际专利分类）是世界知识产权组织维护的专利技术分类体系，每件专利公开时都会标注一个或多个分类号。分类号从左到右逐级细分：
      </p>
      <p className="ipc-path">G 部（物理）→ G06 大类（计算；推算；计数）→ G06V 小类（图像或视频识别或理解）→ G06V 10/82 组（使用神经网络）</p>
      <p>
        填了分类号，雷达会在关键词检索之外再用「分类号 + 关键词」检索一轮，帮你找到同一技术分支里用词不同的专利；它不会过滤掉关键词命中的结果。一般填到 4 位小类（如 G06V）就够，拿不准就留空，只按关键词检索。
      </p>
      <ul className="ipc-sections" aria-label="IPC 八个部">
        {IPC_SECTIONS.map(([code, label]) => (
          <li key={code}>
            <b>{code}</b>
            {label}
          </li>
        ))}
      </ul>
      <p>常用小类（点一下即可填入）：</p>
      <div className="ipc-common">
        {IPC_COMMON.map((item) => (
          <button key={item.code} type="button" className={value.startsWith(item.code) ? "active" : undefined} title={item.label} onClick={() => onPick(item.code)}>
            <b>{item.code}</b>
            {item.label}
          </button>
        ))}
      </div>
      <p>
        想查更细的分类，可以打开{" "}
        <a href="https://ipcpub.wipo.int/" target="_blank" rel="noreferrer" aria-label="WIPO IPC 官方分类表（在新窗口打开）">
          WIPO IPC 官方分类表
        </a>
        ，或在知识库「专利分类与样例」里按 IPC 浏览样例。
      </p>
    </details>
  );
}

export function RadarPage() {
  const { state, dispatch, notify } = useStore();
  const [name, setName] = useState(PRESETS[0].name);
  const [keywords, setKeywords] = useState(PRESETS[0].keywords);
  const [ipc, setIpc] = useState(PRESETS[0].ipc);
  const isPresetActive = (preset: (typeof PRESETS)[number]) => name === preset.name && keywords === preset.keywords && ipc === preset.ipc;
  const [schedule, setSchedule] = useState<Subscription["schedule"]>("daily");
  const [filter, setFilter] = useState("all");
  const [subMotion] = useListMotion();
  const [feedMotion] = useListMotion();
  const running = useRadarRunning();
  const subs = state.subscriptions;

  const feed = useMemo(
    () =>
      subs
        .filter((sub) => filter === "all" || sub.id === filter)
        .flatMap((sub) => (sub.hits ?? []).map((hit) => ({ ...hit, topic: sub.name, subId: sub.id })))
        .sort((a, b) => b.foundAt.localeCompare(a.foundAt))
        .slice(0, 80),
    [subs, filter],
  );
  const lastOk = subs
    .filter((sub) => sub.lastStatus === "ok" && sub.lastRunAt)
    .map((sub) => sub.lastRunAt as string)
    .sort()
    .pop();
  const failed = subs.filter((sub) => sub.lastStatus === "error");
  const total = subs.reduce((sum, sub) => sum + (sub.hits?.length ?? 0), 0);
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const todayCount = subs.reduce((sum, sub) => sum + (sub.hits ?? []).filter((hit) => hit.foundAt.slice(0, 10) === today).length, 0);

  const runOne = async (sub: Subscription) => notify(await runSubscription(sub, dispatch));
  const runAll = async () => {
    const enabled = subs.filter((sub) => sub.enabled);
    if (!enabled.length) {
      notify("没有已启用的订阅。");
      return;
    }
    const reports: RadarRunReport[] = [];
    for (const sub of enabled) {
      try {
        const report = await runSubscriptionReport(sub, dispatch);
        reports.push(report);
        if (report.status !== "busy") notify(report.message);
      } catch (error) {
        // One failing subscription must not stop the rest, and the summary still goes out.
        reports.push({ status: "error", added: 0, message: `「${sub.name}」没有完成：${error instanceof Error ? error.message : String(error)}` });
      }
    }
    notify(summarizeRadarRun(reports, subs.length - enabled.length));
  };

  return (
    <div className="page split-page radar-page">
      <section>
        <p className="kicker">监测</p>
        <h1>专利雷达</h1>
        <p className="lede">
          按专题每天用 AnySearch 检索公开的中国专利页面，只保留带真实公开号（CN…A/B/U）的结果，链到 Google Patents 原文，已见过的号码不再重复提示。这是检索线索，不等于官方数据库的完整收录。
        </p>

        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || !keywords.trim()) return;
            dispatch({ type: "add-sub", name, keywords, schedule, ipc });
            notify(radarSavedNotice(name, schedule));
          }}
        >
          <div className="preset-row">
            {PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                className={isPresetActive(preset) ? "chip active" : "chip"} aria-pressed={isPresetActive(preset)}
                onClick={() => {
                  setName(preset.name);
                  setKeywords(preset.keywords);
                  setIpc(preset.ipc);
                }}
              >
                {preset.name}
              </button>
            ))}
          </div>
          <label>专题名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>关键词（逗号分隔，最多 4 个参与检索）<input value={keywords} onChange={(event) => setKeywords(event.target.value)} /></label>
          <label>
            IPC 分类号（可选，例如 G06V、H01M10）
            <input value={ipc} onChange={(event) => setIpc(event.target.value.toUpperCase())} placeholder="G06V" />
          </label>
          <IpcGuide value={ipc} onPick={setIpc} />
          <label>
            计划
            <select aria-label="计划" value={schedule} onChange={(event) => setSchedule(event.target.value as Subscription["schedule"])}>
              <option value="daily">每日</option>
              <option value="weekly">每周</option>
              <option value="manual">手动</option>
            </select>
          </label>
          <button className="btn primary" type="submit">保存订阅</button>
        </form>

        <ul className="sub-list" ref={subMotion}>
          {subs.length === 0 ? <li className="empty-copy">还没有订阅。点上面的示例专题可以一键填好。</li> : null}
          {subs.map((sub) => {
            const busy = running.includes(sub.id);
            return (
              <li key={sub.id} className={sub.lastStatus === "error" ? "is-error" : undefined}>
                <div>
                  <strong>{sub.name}</strong>
                  <p>
                    {sub.keywords.join("、")}
                    {sub.ipc ? ` · ${sub.ipc}` : ""} · {SCHEDULE_LABEL[sub.schedule]} · {sub.enabled ? "已启用" : "已暂停"}
                  </p>
                  <p className="fine">
                    {busy
                      ? "正在检索…"
                      : sub.lastRunAt
                        ? `${formatTime(sub.lastRunAt)} ${sub.lastStatus === "ok" ? "完成" : "失败"}：${sub.lastDetail ?? ""}${radarDue(sub) ? " 已到下次运行时间。" : ""}`
                        : "还没有运行。"}
                  </p>
                </div>
                <button className="text-btn" type="button" disabled={busy} onClick={() => void runOne(sub)}>{busy ? "检索中" : "立即运行"}</button>
                <button className="text-btn" type="button" onClick={() => dispatch({ type: "toggle-sub", id: sub.id })}>{sub.enabled ? "暂停" : "启用"}</button>
                <button className="text-btn" type="button" onClick={() => dispatch({ type: "remove-sub", id: sub.id })}>删除</button>
              </li>
            );
          })}
        </ul>

        <div className="radar-feed-head">
          <h2>新发现的中国专利</h2>
          <select value={filter} aria-label="按订阅专题筛选" onChange={(event) => setFilter(event.target.value)}>
            <option value="all">全部专题</option>
            {subs.map((sub) => (
              <option key={sub.id} value={sub.id}>{sub.name}</option>
            ))}
          </select>
        </div>
        <ul className="radar-feed" ref={feedMotion}>
          {feed.length === 0 ? <li className="empty-copy">还没有命中。订阅后会自动检索，也可以点“立即运行”。</li> : null}
          {feed.map((hit) => (
            <li key={`${hit.subId}-${hit.pn}`} className="radar-hit">
              <div className="radar-hit-head">
                <a className="pn-badge" href={hit.url} target="_blank" rel="noreferrer">{hit.pn}</a>
                <span className={`kind-tag kind-${kindClass(hit.pn)}`}>{hit.kind}</span>
                <span className="fine">{hit.topic} · {formatTime(hit.foundAt)}</span>
              </div>
              <a className="radar-hit-title" href={hit.url} target="_blank" rel="noreferrer">{hit.title}</a>
              {hit.snippet ? <p className="radar-hit-snippet">{hit.snippet}</p> : null}
              <div className="radar-hit-actions">
                <a className="text-btn" href={hit.url} target="_blank" rel="noreferrer">Google Patents 原文</a>
                {hit.sourceUrl && hit.sourceUrl !== hit.url ? (
                  <a className="text-btn" href={hit.sourceUrl} target="_blank" rel="noreferrer">来源网页</a>
                ) : null}
                <button
                  className="text-btn"
                  type="button"
                  onClick={() => {
                    dispatch({
                      type: "add-knowledge",
                      name: `${hit.pn} ${hit.title}`.slice(0, 60),
                      kind: "text",
                      text: [
                        `公开号：${hit.pn}（${hit.kind}）`,
                        `标题：${hit.title}`,
                        `原文：${hit.url}`,
                        hit.sourceUrl ? `来源：${hit.sourceUrl}` : "",
                        hit.snippet ? `摘要线索：${hit.snippet}` : "",
                        "说明：来自专利雷达的公开网页线索，作为对比文件前请到国家知识产权局专利检索及分析系统核实。",
                      ]
                        .filter(Boolean)
                        .join("\n"),
                    });
                    notify(`${hit.pn} 已存入知识库。`);
                  }}
                >
                  存入知识库
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <aside className="panel health">
        <h2>运行状况</h2>
        <dl className="meta">
          <div><dt>数据源</dt><dd>AnySearch 公开网页（服务端密钥）</dd></div>
          <div><dt>今日新增</dt><dd>{todayCount} 篇</dd></div>
          <div><dt>累计命中</dt><dd>{total} 篇</dd></div>
          <div><dt>上次成功</dt><dd>{lastOk ? formatTime(lastOk) : "无"}</dd></div>
          <div><dt>失败专题</dt><dd>{failed.length ? failed.map((sub) => sub.name).join("、") : "0"}</dd></div>
        </dl>
        <button className="btn primary radar-runall" type="button" disabled={running.length > 0} aria-busy={running.length > 0} onClick={() => void runAll()}>
          {running.length ? "检索中…" : "全部运行一次"}
        </button>
        <p className="fine">打开应用时和保持打开期间每 30 分钟检查一次，到点的专题自动运行。订阅保存在当前浏览器里，应用关闭时不会运行。</p>
        <p className="fine">
          要完整、权威的结果，请到
          <a href="https://pss-system.cponline.cnipa.gov.cn/conventionalSearch" target="_blank" rel="noreferrer"> 专利检索及分析系统 </a>
          或
          <a href="http://epub.cnipa.gov.cn/" target="_blank" rel="noreferrer"> 中国专利公布公告 </a>
          按分类号和日期核实。
        </p>
      </aside>
    </div>
  );
}
