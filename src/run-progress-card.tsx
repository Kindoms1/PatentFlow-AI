import { useEffect, useState } from "react";
import { runProgressView } from "./progress-view.ts";
import type { RunProgress } from "./run-progress.ts";

/**
 * 全自动成稿 / 发明稿的生成进度。
 * 阶段只随流水线真实发出的进度记录前进；计时只显示已用时间，不推算剩余时间或百分比。
 * 显示逻辑在 progress-view.ts（runProgressView），这里只负责每秒刷新已用时间和渲染。
 */
export function RunProgressCard({ progress, since, onStop }: { progress: RunProgress; since: number; onStop?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const view = runProgressView(progress, since, now);

  return (
    <section className="run-progress" aria-label={view.regionLabel} data-kind={progress.kind}>
      <div className="run-progress-head">
        <span className="run-orb" aria-hidden="true">
          <i />
        </span>
        <div className="run-progress-title">
          <b>{view.title}</b>
          <span>{view.stepText}</span>
        </div>
        <span className="run-elapsed" role="timer" aria-live="off" aria-label={view.elapsedLabel}>
          已用 {view.elapsedText}
        </span>
        {onStop ? (
          <button type="button" className="run-stop" onClick={onStop} aria-label="停止生成">
            停止
          </button>
        ) : null}
      </div>
      {view.bar ? (
        <div
          className="run-bar"
          role="progressbar"
          aria-label="生成阶段"
          aria-valuemin={0}
          aria-valuemax={view.bar.max}
          aria-valuenow={view.bar.now}
          aria-valuetext={view.bar.valueText}
        >
          {view.bar.segments.map((segment) => (
            <span key={segment.id} className={`run-seg ${segment.status}`} />
          ))}
        </div>
      ) : null}
      <ol className="run-steps">
        {view.rows.map((row) => (
          <li key={row.id} className={`run-step ${row.status}`} aria-current={row.current ? "step" : undefined} title={row.hint}>
            <span className="run-dot" aria-hidden="true" />
            <span className="run-step-label">{row.label}</span>
            {row.status === "skipped" ? (
              <small className="run-step-tag" aria-hidden="true">
                跳过
              </small>
            ) : null}
            <span className="run-sr">{row.srText}</span>
          </li>
        ))}
      </ol>
      <p className={view.attention ? "run-latest attention" : "run-latest"} aria-live="polite">
        {view.latestText}
      </p>
      {view.stalled ? (
        <p className="run-note" role="note">
          {view.stallText}
        </p>
      ) : null}
    </section>
  );
}
