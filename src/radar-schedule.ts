/** When a radar subscription should run. Pure so node tests can import it without React. */
export interface RadarScheduleFields {
  enabled: boolean;
  schedule: "daily" | "weekly" | "manual";
  lastRunAt?: string;
}

export function radarSavedNotice(name: string, schedule: RadarScheduleFields['schedule']): string {
  return schedule === 'manual'
    ? `已保存「${name.trim()}」，点击“立即运行”手动检索。`
    : `已订阅「${name.trim()}」，几秒后自动跑第一次。`;
}

/** Daily waits 20 hours (so a run drifts with the time the app is opened), weekly 6.5 days, manual never. */
export function radarDue(sub: RadarScheduleFields, now = new Date()): boolean {
  if (!sub.enabled || sub.schedule === "manual") return false;
  if (!sub.lastRunAt) return true;
  const last = new Date(sub.lastRunAt).getTime();
  if (Number.isNaN(last)) return true;
  const gap = sub.schedule === "daily" ? 20 * 3600_000 : 6.5 * 86_400_000;
  return now.getTime() - last >= gap;
}
