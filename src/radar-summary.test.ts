import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeRadarRun } from "./radar-summary.ts";

test("radar run-all summary: all finished with new hits", () => {
  assert.equal(
    summarizeRadarRun([
      { status: "ok", added: 2, message: "a" },
      { status: "ok", added: 3, message: "b" },
    ]),
    "全部运行完成：2 个订阅，2 个完成，共新增 5 篇。",
  );
});

test("radar run-all summary: finished without new hits", () => {
  assert.equal(summarizeRadarRun([{ status: "ok", added: 0, message: "a" }]), "全部运行完成：1 个订阅，1 个完成，没有新增文献。");
});

test("radar run-all summary: a failure switches the heading and is not counted as new hits", () => {
  assert.equal(
    summarizeRadarRun([
      { status: "ok", added: 4, message: "a" },
      { status: "error", added: 9, message: "b" },
    ]),
    "全部运行结束：2 个订阅，1 个完成，共新增 4 篇，1 个没有完成。",
  );
});

test("radar run-all summary: only failures", () => {
  assert.equal(summarizeRadarRun([{ status: "error", added: 0, message: "a" }]), "全部运行结束：1 个订阅，1 个没有完成。");
});

test("radar run-all summary: busy and disabled subscriptions are reported", () => {
  assert.equal(
    summarizeRadarRun(
      [
        { status: "ok", added: 1, message: "a" },
        { status: "busy", added: 0, message: "b" },
      ],
      2,
    ),
    "全部运行结束：2 个订阅，1 个完成，共新增 1 篇，1 个正在检索，已跳过，另有 2 个已停用的订阅未运行。",
  );
});

test("radar run-all summary: negative counts are ignored", () => {
  assert.equal(summarizeRadarRun([{ status: "ok", added: -3, message: "a" }], -1), "全部运行完成：1 个订阅，1 个完成，没有新增文献。");
});