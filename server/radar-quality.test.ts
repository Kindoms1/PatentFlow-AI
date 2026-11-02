import test from "node:test";
import assert from "node:assert/strict";
import { matchesTopic, radarTitle, runRadar, titleFromMention, touchesTopic } from "./patent-radar.ts";

const buildings = { id: "t-build", name: "遥感建筑物", keywords: ["遥感", "建筑物提取"] };

test("radarTitle drops a year glued in front of the invention name", () => {
  assert.equal(radarTitle("2021一种高分遥感影像建筑物提取方法", "", "CN110569751B"), "一种高分遥感影像建筑物提取方法");
  assert.equal(radarTitle("2019年 基于注意力的云检测方法", "", "CN1"), "基于注意力的云检测方法");
  assert.equal(radarTitle("5G基站天线装置", "", "CN2"), "5G基站天线装置");
});

test("radarTitle unwraps a news headline about a granted patent", () => {
  assert.equal(radarTitle("箐云智图取得基于深度学习的遥感影像边缘检测方法专利", "", "CN121458995B"), "基于深度学习的遥感影像边缘检测方法");
  assert.equal(radarTitle("某公司获得“一种遥感影像云检测方法”发明专利授权", "", "CN3"), "一种遥感影像云检测方法");
  assert.equal(radarTitle("一种获得高纯度硅的方法", "", "CN4"), "一种获得高纯度硅的方法");
});

test("radarTitle never borrows the page title or (54) name for a patent the page is not about", () => {
  const snippet = "(54)发明名称 从高空间分辨率光学影像中提取倒塌房屋的方法及装置 引用 CN102917217A";
  assert.equal(radarTitle("(12)发明专利", snippet, "CN102917217A", false), "CN102917217A");
});

test("matchesTopic accepts whole keywords or both halves of a long keyword", () => {
  assert.equal(matchesTopic("建筑物提取模型训练方法、提取方法、设备及存储介质", buildings.keywords), true);
  assert.equal(matchesTopic("一种建筑物轮廓自动提取方法", ["建筑物提取"]), true);
  assert.equal(matchesTopic("基于五边形搜索及三帧背景对齐的动背景视频对象提取", buildings.keywords), false);
  assert.equal(matchesTopic("", buildings.keywords), false);
});

test("runRadar keeps a cited patent only when its own page title is on topic", async () => {
  const search = async () => [
    {
      title: "CN103218597B - 从高空间分辨率光学影像中提取倒塌房屋的方法及装置 - Google Patents",
      url: "https://patents.google.com/patent/CN103218597B/pt",
      snippet: "Cited by CN102917217A CN115439756A CN111460936A",
    },
  ];
  const asked: string[] = [];
  const seen = new Set<string>();
  const run = await runRadar(buildings, search, seen, new Date("2026-10-22T01:00:00Z"), {
    resolveTitle: async (hit) => {
      asked.push(hit.pn);
      if (hit.pn === "CN102917217A") return "CN102917217A - 基于五边形搜索及三帧背景对齐的动背景视频对象提取 - Google Patents";
      if (hit.pn === "CN115439756A") return "CN115439756A - 建筑物提取模型训练方法、提取方法、设备及存储介质 - Google Patents";
      throw new Error("timeout");
    },
  });
  assert.deepEqual(
    run.hits.map((hit) => [hit.pn, hit.title]),
    [
      ["CN103218597B", "从高空间分辨率光学影像中提取倒塌房屋的方法及装置"],
      ["CN115439756A", "建筑物提取模型训练方法、提取方法、设备及存储介质"],
    ],
  );
  assert.deepEqual(asked.sort(), ["CN102917217A", "CN111460936A", "CN115439756A"]);
  assert.equal(seen.has("CN102917217"), false);
  assert.equal(seen.has("CN115439756"), true);
});

test("runRadar resolves own-page fallbacks before cited patents when the budget is tight", async () => {
  const search = async () => [
    { title: "(12)发明专利", url: "https://example.com/CN110176005B.pdf", snippet: "" },
    { title: "CN103218597B - 从高空间分辨率光学影像中提取倒塌房屋的方法及装置 - Google Patents", url: "https://patents.google.com/patent/CN103218597B/zh", snippet: "CN115439756A" },
  ];
  const asked: string[] = [];
  const run = await runRadar(buildings, search, new Set(), new Date("2026-10-22T01:00:00Z"), {
    maxResolve: 1,
    resolveTitle: async (hit) => {
      asked.push(hit.pn);
      return "一种遥感影像建筑物提取方法";
    },
  });
  assert.deepEqual(asked, ["CN110176005B"]);
  assert.deepEqual(run.hits.map((hit) => hit.pn), ["CN110176005B", "CN103218597B"]);
});

const clouds = { id: "t-cloud", name: "遥感云检测", keywords: ["遥感", "云检测"] };

test("touchesTopic accepts a shared two-character fragment but rejects unrelated titles", () => {
  assert.equal(touchesTopic("从高空间分辨率光学影像中提取倒塌房屋的方法及装置", buildings.keywords), true);
  assert.equal(touchesTopic("用于雷达参考地图生成的方法和设备", clouds.keywords), false);
  assert.equal(touchesTopic("一种卫星影像云量检测方法", clouds.keywords), true);
  assert.equal(touchesTopic("", clouds.keywords), false);
});

test("runRadar drops an own-page hit whose verified title is off topic but keeps a number-only PDF fallback", async () => {
  const search = async () => [
    { title: "(12)发明专利", url: "https://patenty.example/pelneteksty/CN114646957B.pdf", snippet: "" },
    { title: "(12)发明专利", url: "https://patenty.example/pelneteksty/CN109446992B.pdf", snippet: "" },
    { title: "CN113744191A - 一种卫星遥感影像自动云检测方法 - Google Patents", url: "https://patents.google.com/patent/CN113744191A/zh", snippet: "" },
  ];
  const run = await runRadar(clouds, search, new Set(), new Date("2026-10-22T01:00:00Z"), {
    resolveTitle: async (hit) => {
      if (hit.pn === "CN114646957B") return "CN114646957B - 用于雷达参考地图生成的方法和设备 - Google Patents";
      throw new Error("timeout");
    },
  });
  assert.deepEqual(
    run.hits.map((hit) => [hit.pn, hit.title, hit.url]),
    [
      ["CN109446992B", "CN109446992B", "https://patents.google.com/patent/CN109446992B/zh"],
      ["CN113744191A", "一种卫星遥感影像自动云检测方法", "https://patents.google.com/patent/CN113744191A/zh"],
    ],
  );
});

const sohuBody =
  "国家知识产权局信息显示，武汉中地软件股份有限公司取得一项名为“遥感影像的建筑对象提取方法、系统、设备及存储介质”的专利，授权公告号CN119007002B，申请日期为2024年7月。";

test("titleFromMention reads an explicitly named invention only when this publication number follows it", () => {
  assert.equal(titleFromMention(sohuBody, "CN119007002B"), "遥感影像的建筑对象提取方法、系统、设备及存储介质");
  assert.equal(titleFromMention(sohuBody, "CN110569751B"), null);
  const two =
    "甲公司取得名为“一种遥感影像云检测方法”的专利，授权公告号CN111111111B；乙公司取得名为“一种建筑物提取装置”的专利，授权公告号CN222222222B。";
  assert.equal(titleFromMention(two, "CN111111111B"), "一种遥感影像云检测方法");
  assert.equal(titleFromMention(two, "CN222222222B"), "一种建筑物提取装置");
  assert.equal(titleFromMention("天眼查资料显示，该公司专利信息73条，公告号CN119007002B。", "CN119007002B"), null);
  assert.equal(titleFromMention("", "CN119007002B"), null);
});

test("runRadar takes a news snippet's explicit invention name and hands sourceUrl to the resolver", async () => {
  const calls: Array<[string, string | undefined]> = [];
  const search = async () => [
    { title: "武汉中地软件取得遥感影像建筑对象提取专利_投资_企业", url: "https://www.sohu.com/a/1068800296_114984", snippet: sohuBody },
    { title: "(12)发明专利", url: "https://example.org/files/CN109446992B.pdf", snippet: "" },
  ];
  const run = await runRadar(buildings, search, new Set(), new Date("2026-10-22T01:00:00Z"), {
    resolveTitle: async (hit) => {
      calls.push([hit.pn, hit.sourceUrl]);
      return null;
    },
  });
  assert.deepEqual(
    run.hits.map((hit) => [hit.pn, hit.title, hit.url]),
    [
      ["CN119007002B", "遥感影像的建筑对象提取方法、系统、设备及存储介质", "https://patents.google.com/patent/CN119007002B/zh"],
      ["CN109446992B", "CN109446992B", "https://patents.google.com/patent/CN109446992B/zh"],
    ],
  );
  assert.deepEqual(calls, [["CN109446992B", "https://example.org/files/CN109446992B.pdf"]]);
});