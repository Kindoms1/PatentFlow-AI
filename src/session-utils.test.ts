import test from "node:test";
import assert from "node:assert/strict";
import { groupSessions, lastActive, relativeTime } from "./session-utils.ts";

const now = new Date("2026-10-23T12:00:00").getTime();
const day = 86_400_000;
const item = (id: string, at: number, pinned = false) => ({ id, createdAt: new Date(at - 1000).toISOString(), messages: [{ at: new Date(at).toISOString() }], pinned });

test("lastActive takes the newest of creation, last message and draft", () => {
  assert.equal(lastActive({ createdAt: new Date(now - day).toISOString(), messages: [], inventionDraft: { at: new Date(now).toISOString() } }), now);
});

test("groupSessions puts pinned first and buckets by recency", () => {
  const groups = groupSessions([item("old", now - 40 * day), item("today", now - 1000), item("pin", now - 50 * day, true), item("week", now - 3 * day), item("month", now - 20 * day)], now);
  assert.deepEqual(groups.map((group) => group.key), ["pinned", "today", "week", "month", "older"]);
  assert.equal(groups[0].items[0].id, "pin");
});

test("relativeTime", () => {
  assert.equal(relativeTime(now - 10_000, now), "刚刚");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5 分钟前");
  assert.equal(relativeTime(now - day, now), "昨天");
  assert.equal(relativeTime(0, now), "");
});
