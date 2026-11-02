import { useState } from "react";
import { KIND_LABEL, LEVEL_LABEL, STAGE_LABEL, confirmedKey, lineDiff } from "./model.ts";
import type { DockTab, FactKind } from "./model.ts";
import type * as ExportDocx from "./export-docx.ts";
import { reportSummary } from "./cnipa-format.ts";
import { SKILL_STEPS } from "./patent-skill.ts";
import { readPdf } from "./read-pdf.ts";
import { runPatentTurn } from "./skill-run.ts";
import { draftContext, parseSlash } from "./skill-turn.ts";
import { useStore } from "./store.tsx";
import { Composer } from "./composer.tsx";
import { ClaimChart, DisclosureView, KindMark, LevelMark, formatTime } from "./widgets.tsx";

const downloadDisclosure: typeof ExportDocx.downloadDisclosure = async (...args) => (await import("./export-docx.ts")).downloadDisclosure(...args);


const TABS: Array<{ id: DockTab; label: string }> = [
  { id: "material", label: "材料" },
  { id: "draft", label: "交底书" },
  { id: "claims", label: "权利要求" },
  { id: "chart", label: "查新" },
  { id: "figures", label: "附图" },
  { id: "diff", label: "差异" },
  { id: "review", label: "审核" },
];

export function CaseView() {
  const { state, dispatch, notify } = useStore();
  const patentCase = state.cases.find((item) => item.id === state.activeCaseId) ?? null;
  const [selectedFact, setSelectedFact] = useState<string | null>(null);
  const [selectedClaim, setSelectedClaim] = useState<string | null>(null);
  const [statement, setStatement] = useState("");
  const [kind, setKind] = useState<FactKind>("effect");
  const [ack, setAck] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<DockTab | null>(null);
  const [exporting, setExporting] = useState(false);

  if (!patentCase) {
    return (
      <div className="page-narrow">
        <h1>还没有打开的案件</h1>
        <button className="btn primary" type="button" onClick={() => dispatch({ type: "navigate", view: "workbench" })}>
          回到工作台
        </button>
      </div>
    );
  }

  const sourceFacts = patentCase.facts.filter((fact) => fact.origin !== "inference");
  const inferences = patentCase.facts.filter((fact) => fact.origin === "inference");
  const pendingSource = sourceFacts.filter((fact) => fact.status === "pending");
  const processReady = patentCase.facts.some((fact) => fact.status === "confirmed" && fact.origin !== "inference" && fact.kind === "process");
  const stale = Boolean(patentCase.disclosure) && patentCase.draftedFrom !== confirmedKey(patentCase.facts);
  const severe = patentCase.issues.some((issue) => issue.level === "severe");
  const needle = patentCase.facts.find((fact) => fact.id === selectedFact)?.statement ?? null;

  const exportDoc = async () => {
    setExporting(true);
    try {
      const report = await downloadDisclosure(patentCase);
      dispatch({ type: "export-done", caseId: patentCase.id });
      notify(report ? `已下载申请文件格式 DOCX。${reportSummary(report)}` : "已下载 DOCX 草稿");
    } catch (error) {
      notify(error instanceof Error ? error.message : "导出失败");
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="case-screen">
      <div className="chat-scroll">
      {patentCase.demo ? <div className="demo-banner">示范案件。文献、对照和结论只用于体验交互，不是官方查新，也不构成法律意见。</div> : null}
      <header className="case-head">
        <div>
          <p className="crumb">发明 · {STAGE_LABEL[patentCase.stage]}</p>
          <h1>{patentCase.title}</h1>
        </div>
        <ol className="stepper skill-steps">
          {SKILL_STEPS.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ol>
        <div className="case-actions">
          <button className="btn primary" type="button" disabled={!processReady} onClick={() => dispatch({ type: "generate", caseId: patentCase.id })}>
            {patentCase.disclosure ? "按已确认事实更新草稿" : "生成交底草稿"}
          </button>
          <button className="btn ghost" type="button" disabled={!ack || !patentCase.disclosure || severe || exporting} onClick={exportDoc}>
            {exporting ? "正在生成文件" : "导出 DOCX"}
          </button>
        </div>
      </header>
      {stale ? <p className="banner">已确认事实和当前草稿不一致。更新草稿会生成新版本，不会直接抹掉上一版。</p> : null}
      <div className="case-body">
        <div className="thread">
          <ol className="messages">
            {patentCase.messages.map((message) => (
              <li key={message.id} className={`msg msg-${message.role}`}>
                {message.role === "trace" ? <i /> : null}
                <div>
                  <p>{message.text}</p>
                  <time>{formatTime(message.at)}</time>
                </div>
              </li>
            ))}
          </ol>
          <section className="fact-block">
            <header>
              <h2>来源事实</h2>
              <button className="text-btn" type="button" disabled={pendingSource.length === 0} onClick={() => dispatch({ type: "confirm-source", caseId: patentCase.id })}>
                确认全部来源事实
              </button>
            </header>
            {sourceFacts.map((fact) => (
              <article key={fact.id} className={`fact ${fact.status} ${selectedFact === fact.id ? "selected" : ""}`}>
                <button type="button" className="fact-main" onClick={() => setSelectedFact(fact.id)}>
                  <KindMark kind={fact.kind} />
                  <span className={`status-word status-${fact.status}`}>{fact.status === "confirmed" ? "已确认" : fact.status === "rejected" ? "已排除" : "待确认"}</span>
                  <p>{fact.statement}</p>
                  <small>{fact.sourceLabel} · {fact.anchor}</small>
                </button>
                {fact.status !== "confirmed" ? (
                  <div className="fact-actions">
                    <button type="button" onClick={() => dispatch({ type: "fact-status", caseId: patentCase.id, factId: fact.id, status: "confirmed" })}>
                      确认
                    </button>
                    <button type="button" onClick={() => dispatch({ type: "fact-status", caseId: patentCase.id, factId: fact.id, status: "rejected" })}>
                      不是事实
                    </button>
                  </div>
                ) : (
                  <button className="text-btn" type="button" onClick={() => dispatch({ type: "fact-status", caseId: patentCase.id, factId: fact.id, status: "pending" })}>
                    撤回确认
                  </button>
                )}
              </article>
            ))}
          </section>
          {inferences.length > 0 ? (
            <section className="fact-block infer-block">
              <header>
                <h2>推断</h2>
                <p>这些话不是材料里的技术事实。知悉之后仍然不会写入正文。</p>
              </header>
              {inferences.map((fact) => (
                <article key={fact.id} className="fact inference">
                  <div className="fact-main">
                    <KindMark kind={fact.kind} />
                    <p>{fact.statement}</p>
                  </div>
                  {fact.status === "pending" ? (
                    <button type="button" onClick={() => dispatch({ type: "fact-status", caseId: patentCase.id, factId: fact.id, status: "confirmed" })}>
                      知悉，不写入
                    </button>
                  ) : (
                    <small>已记录知悉</small>
                  )}
                </article>
              ))}
            </section>
          ) : null}
          {patentCase.proposals.filter((proposal) => proposal.status === "open").map((proposal) => (
            <article key={proposal.id} className="proposal">
              <p className="kicker">修改提案</p>
              <h2>{proposal.title}</h2>
              <p>{proposal.detail}</p>
              <div className="composer-bar">
                <button className="btn primary" type="button" onClick={() => dispatch({ type: "resolve-proposal", caseId: patentCase.id, proposalId: proposal.id, decision: "accepted" })}>
                  接受并生成新版本
                </button>
                <button className="btn ghost" type="button" onClick={() => dispatch({ type: "resolve-proposal", caseId: patentCase.id, proposalId: proposal.id, decision: "rejected" })}>
                  拒绝
                </button>
              </div>
            </article>
          ))}
          <form
            className="supplement"
            onSubmit={(event) => {
              event.preventDefault();
              if (statement.trim().length < 4) return;
              dispatch({ type: "add-fact", caseId: patentCase.id, kind, statement });
              setStatement("");
            }}
          >
            <h2>发明人补充</h2>
            <div className="supplement-row">
              <select value={kind} onChange={(event) => setKind(event.target.value as FactKind)} aria-label="事实类型">
                {Object.entries(KIND_LABEL).map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
              <input value={statement} onChange={(event) => setStatement(event.target.value)} placeholder="补充材料里没有、但你能够确认的事实" />
              <button className="btn ghost" type="submit">写入待用事实</button>
            </div>
          </form>
        </div>
      </div>
      </div>
      <div className="composer-dock">
      <Composer
        value={reply}
        placeholder="继续追问、补充材料，或输入 /发明稿 生成完整申请文件"
        busy={busy}
        onChange={setReply}
        onSubmit={() => {
          if (!reply.trim()) return;
          const message = reply;
          setReply("");
          setBusy(true);
          const slash = parseSlash(message);
          const context = draftContext(patentCase);
          void runPatentTurn({
            caseId: patentCase.id,
            materials: patentCase.materials.length ? patentCase.materials.map((item) => ({ name: item.name, kind: item.kind, text: item.text })) : undefined,
            material: patentCase.materialText,
            fileName: patentCase.materialName,
            history: patentCase.messages,
            intent: slash.intent,
            userText: slash.rest,
            displayText: message,
            pursued: patentCase.ideas.filter((idea) => idea.status === "pursued").map((idea) => idea.title),
            facts: context.facts,
            chosenPoint: context.chosenPoint,
            recordUser: true,
            dispatch,
          }).finally(() => setBusy(false));
        }}
        onPickFile={(file) => {
          void (async () => {
            if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
              const extracted = await readPdf(await file.arrayBuffer());
              if (extracted.trim().length < 8) {
                notify("这份 PDF 没有提取出文字。");
                return;
              }
              setReply(extracted);
              return;
            }
            if (!/\.(txt|md|markdown)$/i.test(file.name)) {
              notify("这里读取 PDF、txt 和 md。");
              return;
            }
            setReply(await file.text());
          })().catch(() => notify("文件没有读出来。"));
        }}
      />
      </div>
      <div className="float-dock">
        {TABS.map((tab) => (
          <button key={tab.id} type="button" className={panel === tab.id ? "active" : undefined} title={tab.label} onClick={() => setPanel((current) => (current === tab.id ? null : tab.id))}>
            {tab.label.slice(0, 1)}
          </button>
        ))}
      </div>
      {panel ? (
        <aside className="float-panel">
          <header className="panel-head">
            <h2>{TABS.find((tab) => tab.id === panel)?.label}</h2>
            <button className="text-btn" type="button" onClick={() => setPanel(null)}>关闭</button>
          </header>
          <div className="dock-body">
            {panel === "material" ? <Material text={patentCase.materialText} needle={needle} name={patentCase.materialName} /> : null}
            {panel === "draft" ? <DisclosureView text={patentCase.disclosure} /> : null}
            {panel === "claims" ? (
              <div className="claim-list">
                {patentCase.claims.length === 0 ? <p className="empty-copy">生成草稿后，这里显示权利要求树。</p> : null}
                {patentCase.claims.filter((claim) => claim.parentNo === null).map((claim) => (
                  <div key={claim.id}>
                    <ClaimButton claimId={claim.id} no={claim.no} text={claim.text} selected={selectedClaim === claim.id} onSelect={setSelectedClaim} />
                    {patentCase.claims.filter((child) => child.parentNo === claim.no).map((child) => (
                      <div key={child.id} className="claim-child">
                        <ClaimButton claimId={child.id} no={child.no} text={child.text} selected={selectedClaim === child.id} onSelect={setSelectedClaim} />
                      </div>
                    ))}
                  </div>
                ))}
                {selectedClaim ? <EvidenceLinks patentCaseId={patentCase.id} claimId={selectedClaim} /> : null}
              </div>
            ) : null}
            {panel === "chart" ? <ClaimChart patentCase={patentCase} /> : null}
            {panel === "figures" ? (
              <div className="flow">
                {patentCase.figures.length === 0 ? <p className="empty-copy">生成草稿时会按已确认的输入、处理和输出建立附图骨架。</p> : null}
                {patentCase.figures.map((figure) => (
                  <label key={figure.id} className="flow-node">
                    <span>图{figure.no}</span>
                    <input
                      value={figure.label}
                      aria-label={`图${figure.no}名称`}
                      onChange={(event) => dispatch({ type: "figure-label", caseId: patentCase.id, figureId: figure.id, label: event.target.value })}
                    />
                  </label>
                ))}
                <p className="fine">这是可编辑的步骤骨架，不是由图像模型绘制的机械图。</p>
              </div>
            ) : null}
            {panel === "diff" ? <DiffView versions={patentCase.versions} /> : null}
            {panel === "review" ? (
              <div className="review">
                {patentCase.issues.length === 0 ? <p className="empty-copy">生成草稿后，这里按严重问题、需人工确认和建议优化列出缺口。</p> : null}
                {(["severe", "confirm", "improve"] as const).map((level) => {
                  const items = patentCase.issues.filter((issue) => issue.level === level);
                  if (items.length === 0) return null;
                  return (
                    <section key={level}>
                      <h2>{LEVEL_LABEL[level]}</h2>
                      {items.map((issue) => (
                        <article key={issue.id}>
                          <LevelMark level={issue.level} />
                          <strong>{issue.title}</strong>
                          <p>{issue.detail}</p>
                          {issue.factId ? (
                            <button className="text-btn" type="button" onClick={() => setSelectedFact(issue.factId ?? null)}>
                              定位事实
                            </button>
                          ) : null}
                        </article>
                      ))}
                    </section>
                  );
                })}
                <label className="check">
                  <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
                  我确认导出的是辅助草稿，不是正式申请文本。
                </label>
                {severe ? <p className="form-error">存在严重问题，导出已停用。</p> : null}
                <h2>轨迹</h2>
                <ul className="audit">
                  {patentCase.audit.slice(0, 8).map((event) => (
                    <li key={event.id}>
                      <strong>{event.action}</strong>
                      <span>{formatTime(event.at)}</span>
                      <p>{event.detail}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </aside>
      ) : null}
    </section>
  );
}

function ClaimButton({ claimId, no, text, selected, onSelect }: { claimId: string; no: number; text: string; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button type="button" className={selected ? "claim selected" : "claim"} onClick={() => onSelect(claimId)}>
      <b>权利要求 {no}</b>
      <span>{text}</span>
    </button>
  );
}

function EvidenceLinks({ patentCaseId, claimId }: { patentCaseId: string; claimId: string }) {
  const { state, dispatch } = useStore();
  const patentCase = state.cases.find((item) => item.id === patentCaseId);
  const claim = patentCase?.claims.find((item) => item.id === claimId);
  if (!patentCase || !claim) return null;
  const facts = patentCase.facts.filter((fact) => claim.factIds.includes(fact.id));
  return (
    <div className="evidence-box">
      <h2>这条权利要求使用的事实</h2>
      {facts.map((fact) => (
        <p key={fact.id}>
          {fact.statement}
          <small> · {fact.anchor}</small>
        </p>
      ))}
      <button className="text-btn" type="button" onClick={() => dispatch({ type: "set-dock", tab: "material" })}>
        回到材料
      </button>
    </div>
  );
}

function Material({ text, needle, name }: { text: string; needle: string | null; name: string }) {
  const index = needle ? text.indexOf(needle) : -1;
  return (
    <article className="paper source-paper">
      <p className="fine">{name}</p>
      <p>
        {index >= 0 && needle ? (
          <>
            {text.slice(0, index)}
            <mark>{needle}</mark>
            {text.slice(index + needle.length)}
          </>
        ) : (
          text
        )}
      </p>
    </article>
  );
}

function DiffView({ versions }: { versions: Array<{ id: string; label: string; at: string; actor: string; reason: string; claimsText: string; disclosure: string }> }) {
  if (versions.length < 2) return <p className="empty-copy">接受一次修改提案，或再次更新草稿后，这里比较相邻版本。现在只有 {versions.length} 个版本。</p>;
  const next = versions[versions.length - 1];
  const prev = versions[versions.length - 2];
  const claimRows = lineDiff(prev.claimsText, next.claimsText).filter((row) => row.type !== "same");
  const docRows = lineDiff(prev.disclosure, next.disclosure).filter((row) => row.type !== "same");
  return (
    <div className="diff">
      <p className="fine">{prev.label} → {next.label} · {next.actor} · {next.reason}</p>
      <h2>权利要求</h2>
      {claimRows.length === 0 ? <p>权利要求文本没有变化。</p> : claimRows.map((row, index) => <p key={`${row.type}-${index}`} className={`diff-${row.type}`}>{row.text}</p>)}
      <h2>交底书</h2>
      {docRows.length === 0 ? <p>交底书正文没有变化。</p> : docRows.slice(0, 30).map((row, index) => <p key={`d-${row.type}-${index}`} className={`diff-${row.type}`}>{row.text}</p>)}
      <h2>版本</h2>
      <ul className="audit">
        {versions.map((version) => (
          <li key={version.id}>
            <strong>{version.label}</strong>
            <span>{formatTime(version.at)} · {version.actor}</span>
            <p>{version.reason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
