import test from "node:test";
import assert from "node:assert/strict";
import { cleanPatentTitle, gatherPriorArt, relevanceHits, titleFromContent, titleProblem, topicTerms } from "./prior-art.ts";

const TOPIC = "一种带自清洁刮板的雨水井截污装置";

test("irrigation prior art excludes railway and generic electronic compensation matches", async () => {
  const refs = await gatherPriorArt(["滴灌 分区 补偿 专利"], {
    topic: "一种基于堵塞等级与轮灌水量偏差的温室滴灌分区补偿控制方法 接收堵塞分区等级形成闭环补偿反馈",
    search: async () => ({ok:true,detail:"",results:[
      {title:"一种滴灌系统灌水器堵塞特性的综合评价方法及测试系统",url:"https://patents.google.com/patent/CN102564747B/zh",snippet:"通过分区流量检测灌水器堵塞程度"},
      {title:"一种确定解锁闭塞分区的失去分路状态的方法及装置",url:"https://patents.google.com/patent/CN121375898B/zh",snippet:"轨道电路对闭塞分区进行分区反馈控制"},
      {title:"一种闭环控制环路补偿速度自动调节的实现方法",url:"https://patents.google.com/patent/CN119010595A/zh",snippet:"电源闭环补偿反馈电路"},
    ]}),
  });
  assert.deepEqual(refs.map(ref=>ref.pn),["CN102564747B"]);
});

test("titleProblem separates real titles from document-type labels, news and truncated text", () => {
  assert.equal(titleProblem("(12)发明专利", "CN107761681B"), "placeholder");
  assert.equal(titleProblem("（12）发明专利申请"), "placeholder");
  assert.equal(titleProblem("(19)中华人民共和国国家知识产权局"), "placeholder");
  assert.equal(titleProblem("实用新型专利"), "placeholder");
  assert.equal(titleProblem("CN107761681B", "CN107761681B"), "placeholder");
  assert.equal(titleProblem("贝斯美科技取得薄膜蒸发器防清理装置专利，可即时剥离刚 ..."), "news");
  assert.equal(titleProblem("一种雨水检查井智能截污…"), "truncated");
  assert.equal(titleProblem("一种面源控污雨水井"), "");
  assert.equal(titleProblem("自动力自清洁屋面雨水收集处理系统装置"), "");
});

test("cleanPatentTitle drops a bare leading publication number", () => {
  assert.equal(cleanPatentTitle("CN107761681B (12)发明专利"), "(12)发明专利");
  assert.equal(cleanPatentTitle("CN104074262B - 一种雨水检查井智能截污装置 - Google Patents"), "一种雨水检查井智能截污装置");
});

test("topic terms skip filler and generic words; relevance counts distinct hits", () => {
  const terms = topicTerms(TOPIC);
  for (const term of ["雨水", "截污", "刮板", "清洁"]) assert.ok(terms.includes(term), term);
  for (const term of ["装置", "一种", "板的", "带自"]) assert.ok(!terms.includes(term), term);
  assert.equal(relevanceHits(terms, "一种面源控污雨水井"), 2);
  assert.equal(relevanceHits(terms, "一种薄膜蒸发器防清理装置"), 0);
});

test("titleFromContent reads the 一种…… title from a page's opening text", () => {
  assert.equal(titleFromContent("CN107761681B 摘要 本发明公开了一种雨水井用自清洁过滤装置，包括井体和滤网。"), "一种雨水井用自清洁过滤装置");
  assert.equal(titleFromContent("Abstract only English text here"), "");
});

test("gatherPriorArt repairs or drops document-type titles, drops news items and off-topic patents", async () => {
  const extracted: string[] = [];
  const traces: string[] = [];
  const refs = await gatherPriorArt(["雨水井 截污 专利"], {
    topic: TOPIC,
    search: async () => ({
      ok: true,
      detail: "",
      results: [
        { title: "CN107642204A - 自动力自清洁屋面雨水收集处理系统装置 - Google Patents", url: "https://patents.google.com/patent/CN107642204A/zh", snippet: "" },
        { title: "(12)发明专利", url: "https://example.com/pdf/CN107761681B.pdf", snippet: "CN107761681B" },
        { title: "贝斯美科技取得薄膜蒸发器防清理装置专利，可即时剥离刚 ...", url: "https://news.example.com/a", snippet: "公告号CN224864922U" },
        { title: "一种薄膜蒸发器", url: "https://patents.google.com/patent/CN111111111A/zh", snippet: "" },
        { title: "(12)发明专利", url: "https://example.com/pdf/CN122222222B.pdf", snippet: "CN122222222B" },
        { title: "一种面源控污雨水井", url: "https://patents.google.com/patent/CN109372087B/zh", snippet: "" },
        { title: "一种雨水检查井智能截污装置", url: "https://patents.google.com/patent/CN104074262B/zh", snippet: "" },
      ],
    }),
    extract: async (url) => {
      extracted.push(url);
      if (url.includes("CN107761681B")) {
        return { ok: true, title: "", content: "摘要 本发明公开了一种雨水井截污清掏装置，包括井体、截污篮和提升机构，便于清理雨水井中的杂物，减少人工下井作业。" };
      }
      if (url.includes("CN122222222B")) return { ok: true, title: "(12)发明专利", content: "" };
      return { ok: false, content: "" };
    },
    onTrace: (text) => traces.push(text),
  });
  assert.deepEqual(
    refs.map((ref) => ref.pn),
    ["CN107642204A", "CN107761681B", "CN109372087B", "CN104074262B"],
  );
  assert.equal(refs[1].title, "一种雨水井截污清掏装置");
  assert.ok(!extracted.some((url) => url.includes("CN111111111A")), "an off-topic patent with a proper title is not read");
  const dropLine = traces.find((line) => line.startsWith("已剔除")) || "";
  assert.match(dropLine, /CN224864922U/);
  assert.match(dropLine, /CN122222222B/);
  assert.match(dropLine, /CN111111111A/);
});
