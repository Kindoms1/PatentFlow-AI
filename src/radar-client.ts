/**
 * Browser side of the daily patent radar.
 *
 * Subscriptions live in the local workspace, so the schedule runs where the data is: when the app opens
 * and every 30 minutes while it stays open, each enabled subscription that is due is sent to
 * POST /api/radar/run (AnySearch on the server, CN publication numbers only). Already-seen numbers are
 * sent along so a topic only reports documents it has not shown before.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { RadarRunReport } from "./radar-summary.ts";
import type { Dispatch } from "react";
import type { Action, RadarHitView, Subscription } from "./model.ts";
import { runRadarApi } from "./provider-api.ts";
import { radarDue } from "./radar-schedule.ts";
import { useStore } from "./store.tsx";

export { radarDue };

const running = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: string[] = [];

function publish(): void {
  snapshot = [...running];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ids of subscriptions whose radar run is in flight. */
export function useRadarRunning(): string[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** Run one subscription now. Returns a short Chinese line for a toast. */
export async function runSubscription(sub: Subscription, dispatch: Dispatch<Action>): Promise<string> {
  return (await runSubscriptionReport(sub, dispatch)).message;
}

/** Same run as runSubscription, plus the status and new-hit count "全部运行一次" needs for its summary. */
export async function runSubscriptionReport(sub: Subscription, dispatch: Dispatch<Action>): Promise<RadarRunReport> {
  if (running.has(sub.id)) return { status: "busy", added: 0, message: `「${sub.name}」正在检索。` };
  running.add(sub.id);
  publish();
  try {
    const outcome = await runRadarApi({
      topic: { id: sub.id, name: sub.name, keywords: sub.keywords, ipc: sub.ipc },
      seen: sub.seen ?? [],
    });
    const hits: RadarHitView[] = outcome.hits.map((hit) => ({
      pn: hit.pn,
      kind: hit.kind,
      title: hit.title,
      url: hit.url,
      sourceUrl: hit.sourceUrl,
      snippet: hit.snippet,
      query: hit.query,
      foundAt: hit.foundAt,
    }));
    const detail = outcome.ok
      ? `${outcome.queries.length} 个检索式，新增 ${hits.length} 篇${outcome.skippedSeen ? `，跳过已见 ${outcome.skippedSeen} 篇` : ""}${outcome.errors.length ? `，${outcome.errors.length} 个检索式失败` : ""}。`
      : outcome.detail || outcome.errors[0] || "检索没有完成。";
    dispatch({ type: "radar-result", id: sub.id, ranAt: outcome.ranAt || new Date().toISOString(), ok: outcome.ok, detail, hits });
    return outcome.ok
      ? { status: "ok", added: hits.length, message: `「${sub.name}」${detail}` }
      : { status: "error", added: 0, message: `「${sub.name}」没有完成：${detail}` };
  } finally {
    running.delete(sub.id);
    publish();
  }
}

/** Mount once (in the shell): runs due subscriptions on open and every 30 minutes. */
export function useRadarAutoRun(): void {
  const { state, dispatch } = useStore();
  const subs = state.subscriptions;
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      for (const sub of subs) {
        if (cancelled) return;
        if (!radarDue(sub) || running.has(sub.id)) continue;
        // A failed run also stamps lastRunAt, so a missing key does not retry every 30 minutes.
        await runSubscription(sub, dispatch);
      }
    };
    const first = window.setTimeout(() => void tick(), 4000);
    const timer = window.setInterval(() => void tick(), 30 * 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [subs, dispatch]);
}
