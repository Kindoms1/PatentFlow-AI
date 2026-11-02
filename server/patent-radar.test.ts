import test from "node:test";
import assert from "node:assert/strict";
import { isDue, radarQueries, runRadar } from "./patent-radar.ts";

const topic = { id: "t1", name: "云检测", keywords: ["遥感", "云检测"], ipc: "G06V20/13" };

test("radarQueries builds short single-intent queries incl. IPC", () => {
  const queries = radarQueries(topic, new Date("2026-10-22T00:00:00Z"));
  assert.equal(queries.length, 4);
  assert.ok(queries.every((q) => q.includes("遥感 云检测")));
  assert.match(queries[3], /^G06V20\/13/);
});

test("runRadar keeps only CN numbers, links them and skips seen ones", async () => {
  const seen = new Set(["CN113033448"]);
  const search = async (query: string) => {
    if (query.includes("授权")) throw new Error("rate limited");
    return [
      { title: "CN114494821A - 基于多尺度感知的云检测方法 - Google Patents", url: "https://patents.google.com/patent/CN114494821A/zh", snippet: "扩张卷积" },
      { title: "去云网络", url: "https://example.com/a", snippet: "公开号 CN113033448B" },
      { title: "期刊论文", url: "https://journal.example/x", snippet: "无公开号" },
    ];
  };
  const run = await runRadar(topic, search, seen, new Date("2026-10-22T01:00:00Z"));
  assert.equal(run.hits.length, 1);
  assert.equal(run.hits[0].pn, "CN114494821A");
  assert.equal(run.hits[0].title, "基于多尺度感知的云检测方法");
  assert.equal(run.hits[0].url, "https://patents.google.com/patent/CN114494821A/zh");
  assert.equal(run.skippedSeen, 1);
  assert.equal(run.errors.length, 1);
  assert.ok(seen.has("CN114494821"));
});

test("isDue respects schedule", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  assert.equal(isDue(undefined, "daily", now), true);
  assert.equal(isDue("2026-10-22T08:00:00Z", "daily", now), false);
  assert.equal(isDue("2026-10-21T08:00:00Z", "daily", now), true);
  assert.equal(isDue("2026-10-21T08:00:00Z", "manual", now), false);
});
