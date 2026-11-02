/** Outcome of one radar subscription run, used to summarise "全部运行一次". */
export interface RadarRunReport {
  /** "ok": the search finished; "error": it ran but did not finish; "busy": that subscription was already running and was skipped. */
  status: "ok" | "error" | "busy";
  /** New publications added by this run; only counted when status is "ok". */
  added: number;
  /** One-line notice for this subscription, the same text runSubscription returns. */
  message: string;
}

/** One notice for the end of "全部运行一次": how many ran, finished, failed or were skipped, and how many publications are new. */
export function summarizeRadarRun(reports: readonly RadarRunReport[], skippedDisabled = 0): string {
  const done = reports.filter((report) => report.status === "ok").length;
  const failed = reports.filter((report) => report.status === "error").length;
  const busy = reports.filter((report) => report.status === "busy").length;
  const added = reports.reduce((sum, report) => sum + (report.status === "ok" ? Math.max(0, report.added) : 0), 0);
  const parts: string[] = [`${reports.length} 个订阅`];
  if (done) {
    parts.push(`${done} 个完成`);
    parts.push(added ? `共新增 ${added} 篇` : "没有新增文献");
  }
  if (failed) parts.push(`${failed} 个没有完成`);
  if (busy) parts.push(`${busy} 个正在检索，已跳过`);
  if (skippedDisabled > 0) parts.push(`另有 ${skippedDisabled} 个已停用的订阅未运行`);
  const head = failed || busy ? "全部运行结束" : "全部运行完成";
  return `${head}：${parts.join("，")}。`;
}