import type { ReactNode } from "react";
import { KIND_LABEL, LEVEL_LABEL, PUBLICATIONS, evidenceSnippet, judge } from "./model.ts";
import type { FactKind, IssueLevel, PatentCase, Publication } from "./model.ts";

export function formatTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name] ?? paths.dot}
    </svg>
  );
}

const paths: Record<string, ReactNode> = {
  dot: <circle cx="12" cy="12" r="3" />,
  workbench: <path d="M4 6h16M4 12h10M4 18h7" />,
  cases: <path d="M3 7h6l2 2h10v10H3z" />,
  knowledge: <path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 0-3 3zM5 4v16" />,
  radar: <path d="M12 12l6-3M12 12a7 7 0 1 0-4 6.3M12 12v0" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="M16 16l4 4" /></>,
  analysis: <path d="M5 19V9M12 19V5M19 19v-7" />,
  skills: <path d="M12 3l2.2 4.6L19 8.2l-3.5 3.4.8 4.9L12 14.8 7.7 16.5l.8-4.9L5 8.2l4.8-.6z" />,
  models: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 9h.01M15 9h.01M9 15h6" /></>,
  tasks: <path d="M8 7h11M8 12h11M8 17h11M4 7h.01M4 12h.01M4 17h.01" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>,
  bell: <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2H4.5zM10 19a2 2 0 0 0 4 0" />,
  command: <path d="M5 8V6a2 2 0 1 1 2-2h0M5 16v2a2 2 0 1 0 2 2h0M19 8V6a2 2 0 1 0-2-2h0M19 16v2a2 2 0 1 1-2 2h0M8 12h8" />,
};

export function DisclosureView({ text }: { text: string }) {
  if (!text) return <p className="empty-copy">确认事实后，交底书会出现在这里。</p>;
  return (
    <article className="paper">
      {text.split("\n").map((line, index) => {
        const key = `${index}-${line.slice(0, 16)}`;
        if (/^\s*```/.test(line)) return null;
        if (line.startsWith("# ")) return <h1 key={key}>{line.slice(2)}</h1>;
        if (line.startsWith("## ")) return <h2 key={key}>{line.slice(3)}</h2>;
        if (/^#{3,6}\s/.test(line)) return <h3 key={key}>{line.replace(/^#{3,6}\s+/, "")}</h3>;
        if (!line.trim()) return <div key={key} className="spacer" />;
        return (
          <p key={key} className={line.includes("【待补充】") ? "missing" : undefined}>
            {line.replace(/^- /, "")}
          </p>
        );
      })}
    </article>
  );
}

export function LevelMark({ level }: { level: IssueLevel }) {
  return <span className={`mark mark-${level}`}>{LEVEL_LABEL[level]}</span>;
}

export function KindMark({ kind }: { kind: FactKind }) {
  return <span className="kind">{KIND_LABEL[kind]}</span>;
}

export function ClaimChart({ patentCase }: { patentCase: PatentCase }) {
  const slots = [
    ["D1", patentCase.priorArt.d1],
    ["D2", patentCase.priorArt.d2],
  ] as const;
  const pubs = slots
    .map(([slot, id]) => ({ slot, publication: PUBLICATIONS.find((item) => item.id === id) ?? null }))
    .filter((item): item is { slot: "D1" | "D2"; publication: Publication } => Boolean(item.publication));
  const features = patentCase.facts.filter((fact) => fact.status === "confirmed" && fact.origin !== "inference" && fact.kind !== "problem");
  if (pubs.length === 0) {
    return <p className="empty-copy">还没有对比文件。到专利检索里把示范文献标成 D1 或 D2，对照表会按原文位置生成。</p>;
  }
  if (features.length === 0) {
    return <p className="empty-copy">先确认技术事实，再看特征对照。</p>;
  }
  return (
    <div className="table-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th>已确认特征</th>
            {pubs.map((item) => (
              <th key={item.slot}>
                {item.slot} · {item.publication.number}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {features.map((fact) => (
            <tr key={fact.id}>
              <td>{fact.statement}</td>
              {pubs.map((item) => {
                const corpus = `${item.publication.text}\n${item.publication.claimsText}`;
                const judgement = judge(fact.statement, corpus);
                return (
                  <td key={item.slot}>
                    <span className={`judge judge-${judgement}`}>{judgement}</span>
                    <small>{evidenceSnippet(fact.statement, corpus)}</small>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fine">对照依据是字面片段是否出现，不是新颖性、创造性或侵权结论。</p>
    </div>
  );
}
