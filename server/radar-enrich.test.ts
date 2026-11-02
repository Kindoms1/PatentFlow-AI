import test from "node:test";
import assert from "node:assert/strict";
import { looksLikeInventionTitle, radarTitle, runRadar, titleFromPatentPage } from "./patent-radar.ts";

const topic = { id: "t2", name: "建筑物", keywords: ["遥感", "建筑物提取"] };

test("radarTitle strips a trailing search ellipsis", () => {
  assert.equal(radarTitle("基于深度学习的遥感影像建筑物提取方法 ...", "", "CN109446992B"), "基于深度学习的遥感影像建筑物提取方法");
  assert.equal(radarTitle("一种光学遥感图像云检测方法…", "", "CN101799921A"), "一种光学遥感图像云检测方法");
});

test("radarTitle rejects a scholar profile page title", () => {
  assert.equal(radarTitle("陶淑苹-中国科学院大学-UCAS", "授权专利 CN110996005B", "CN110996005B"), "CN110996005B");
});

test("radarTitle does not stamp a listing page title on a patent the page is not about", () => {
  assert.equal(radarTitle("一种卫星遥感影像自动云检测方法", "", "CN101566692A", false), "CN101566692A");
});

test("looksLikeInventionTitle separates invention names from page titles and sentences", () => {
  assert.equal(looksLikeInventionTitle("一种保温杯"), true);
  assert.equal(looksLikeInventionTitle("基于U-Net网络的遥感影像建筑物提取方法、系统、电子设备"), true);
  assert.equal(looksLikeInventionTitle("本发明公开了一种云检测方法。"), false);
  assert.equal(looksLikeInventionTitle("CN110176005B"), false);
  assert.equal(looksLikeInventionTitle("Cloud detection method"), false);
});

test("titleFromPatentPage reads the page title first, then the body", () => {
  assert.equal(titleFromPatentPage("CN110176005B - 一种遥感影像建筑物提取方法 - Google Patents", ""), "一种遥感影像建筑物提取方法");
  assert.equal(titleFromPatentPage("Google Patents", "CN114646957B\n# 一种基于多光谱的云检测方法\n本发明公开了一种方法，包括步骤。"), "一种基于多光谱的云检测方法");
  assert.equal(titleFromPatentPage("", "摘要\n本发明公开了一种云检测方法，包括步骤。"), null);
});

test("runRadar fills fallback titles through resolveTitle and ignores bad or failing lookups", async () => {
  const search = async () => [
    { title: "(12)发明专利", url: "https://example.com/CN110176005B.pdf", snippet: "授权公告" },
    { title: "陶淑苹-中国科学院大学-UCAS", url: "https://people.example/tao", snippet: "授权专利 CN110996005B" },
    { title: "CN114646957B", url: "https://example.com/CN114646957B.pdf", snippet: "" },
  ];
  const asked: Array<{ pn: string; url: string }> = [];
  const run = await runRadar(topic, search, new Set(), new Date("2026-10-22T01:00:00Z"), {
    resolveTitle: async (hit) => {
      asked.push(hit);
      if (hit.pn === "CN110176005B") return "CN110176005B - 一种遥感影像建筑物提取方法 - Google Patents";
      if (hit.pn === "CN110996005B") return "陶淑苹-中国科学院大学-UCAS";
      throw new Error("timeout");
    },
  });
  const titles = Object.fromEntries(run.hits.map((hit) => [hit.pn, hit.title]));
  assert.deepEqual(titles, { CN110176005B: "一种遥感影像建筑物提取方法", CN110996005B: "CN110996005B", CN114646957B: "CN114646957B" });
  assert.deepEqual(asked.map((hit) => hit.pn).sort(), ["CN110176005B", "CN110996005B", "CN114646957B"]);
  assert.ok(asked.every((hit) => hit.url === `https://patents.google.com/patent/${hit.pn}/zh`));
  assert.equal(run.errors.length, 0);
});

test("runRadar caps title lookups with maxResolve and skips hits that already have a title", async () => {
  const search = async () => [
    { title: "CN114387523A - 基于dcnn边界引导的遥感图像建筑物提取方法 - Google Patents", url: "https://patents.google.com/patent/CN114387523A/zh", snippet: "" },
    { title: "(12)发明专利", url: "https://example.com/CN110176005B.pdf", snippet: "" },
    { title: "(12)发明专利", url: "https://example.com/CN114646957B.pdf", snippet: "" },
  ];
  let calls = 0;
  const run = await runRadar(topic, search, new Set(), new Date("2026-10-22T01:00:00Z"), {
    maxResolve: 1,
    resolveTitle: async () => {
      calls += 1;
      return "一种遥感影像云检测方法";
    },
  });
  assert.equal(calls, 1);
  assert.equal(run.hits.find((hit) => hit.pn === "CN114387523A")?.title, "基于dcnn边界引导的遥感图像建筑物提取方法");
  assert.equal(run.hits.filter((hit) => hit.title === "一种遥感影像云检测方法").length, 1);
});