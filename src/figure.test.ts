import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFigureSpecs, figureSpecBlock, figureSpecRefs, normalizeFigureSpec, plainLabel } from "./figure-spec.ts";
import type { FigureSpecIssue } from "./figure-spec.ts";
import { renderFigure, richRuns, textWidth, wrapText, MAX_HEIGHT_MM, MAX_WIDTH_MM } from "./figure-render.ts";
import { rasterizeFigure, withPngDpi } from "./figure-raster.ts";
import { crc32 } from "./zip.ts";
import { auditFigures, parseReferenceList, referenceSection, textReferences } from "./figure-audit.ts";

const FLOW = `{"no":2,"kind":"flow","steps":[
{"id":"S1","text":"S1 采集各土层体积含水率θ_i和气象数据"},
{"id":"S2","text":"S2 计算参考作物蒸散量ET_0"},
{"id":"S3","text":"S3 判断预测含水率是否低于下限","shape":"decision"},
{"id":"S4","text":"S4 计算补水量并下发灌溉指令"}],
"edges":[["S1","S2"],["S2","S3"],["S3","S4","是"],["S3","S1","否"]]}`;

const BLOCK = `{"no":1,"kind":"block","nodes":[
{"id":"a","text":"土壤墒情监测单元","ref":"10"},
{"id":"b","text":"气象数据获取单元","ref":"20"},
{"id":"c","text":"决策控制器","ref":"30"},
{"id":"d","text":"灌溉执行单元","ref":"40"}],
"edges":[{"from":"a","to":"c"},{"from":"b","to":"c"},{"from":"c","to":"d","both":true},{"from":"d","to":"a","label":"反馈"}]}`;

const LAYERS = `{"no":3,"kind":"layers","layers":[{"ref":"41","thickness":15,"dim":"15 cm"},{"ref":"42","thickness":20,"dim":"20 cm"}],
"items":[{"ref":"11","depth":7.5,"x":0.3,"lead":true},{"ref":"12","depth":25,"x":0.3,"lead":true}]}`;

const STRUCTURE = `{"no":4,"kind":"structure","shapes":[
{"kind":"line","points":[[0,40],[200,40]],"ref":"51"},
{"kind":"rect","x":60,"y":20,"w":40,"h":40,"ref":"52"},
{"kind":"circle","cx":140,"cy":40,"r":14,"ref":"53"}]}`;

function draft(blocks: string[]): string {
  return ["## 附图说明", "图1为系统框图。", ...blocks.map((block) => "```附图\n" + block + "\n```"), "## 具体实施方式", "正文。"].join("\n");
}

test("附图代码块被取出、规范化，正文不残留 JSON", () => {
  const { specs, issues, text } = extractFigureSpecs(draft([BLOCK, FLOW, LAYERS, STRUCTURE]));
  assert.deepEqual(issues, []);
  assert.deepEqual(specs.map((spec) => spec.no), [1, 2, 3, 4]);
  assert.deepEqual(specs.map((spec) => spec.kind), ["block", "flow", "layers", "structure"]);
  assert.ok(!text.includes("```") && !text.includes('"kind"'));
  assert.ok(text.includes("图1为系统框图。") && text.includes("正文。"));
  assert.equal(specs[1].steps[2].shape, "decision");
  assert.deepEqual(specs[1].edges[2], { from: "S3", to: "S4", label: "是" });
  assert.deepEqual(figureSpecRefs(specs[0]), ["10", "20", "30", "40"]);
});

test("坏数据给出中文原因，不抛异常", () => {
  const { specs, issues } = extractFigureSpecs("```附图\n{not json}\n```\n```附图\n{\"no\":2,\"kind\":\"pie\"}\n```\n```附图\n{\"no\":3,\"kind\":\"flow\",\"steps\":[\"A\",\"B\"],\"edges\":[[\"x\",\"y\"]]}\n```");
  assert.equal(specs.length, 1);
  assert.ok(issues.some((issue) => /不是合法 JSON/.test(issue.message)));
  assert.ok(issues.some((issue) => /无法识别/.test(issue.message)));
  assert.ok(issues.some((issue) => /不存在的步骤/.test(issue.message)));
  const unclosed = extractFigureSpecs("```附图\n" + FLOW);
  assert.ok(unclosed.issues.some((issue) => /没有闭合/.test(issue.message)));
  assert.equal(unclosed.specs.length, 1);
});

test("非数字标记和单出口判断框被指出", () => {
  const issues: FigureSpecIssue[] = [];
  normalizeFigureSpec({ no: 1, kind: "block", nodes: [{ text: "控制器", ref: "A1" }] }, issues);
  normalizeFigureSpec({ no: 2, kind: "flow", steps: [{ id: "S1", text: "S1 判断", shape: "decision" }, { id: "S2", text: "S2 结束" }], edges: [["S1", "S2"]] }, issues);
  assert.ok(issues.some((issue) => /不是阿拉伯数字/.test(issue.message)));
  assert.ok(issues.some((issue) => /只有一个出口/.test(issue.message)));
});

test("写回代码块再读取，数据不变", () => {
  const { specs } = extractFigureSpecs(draft([BLOCK, FLOW, LAYERS, STRUCTURE]));
  const again = extractFigureSpecs(specs.map(figureSpecBlock).join("\n")).specs;
  assert.deepEqual(again, specs);
});

test("标签去掉 LaTeX 外壳，下标拆段，换行不拆英文数字", () => {
  assert.equal(plainLabel("$K_s$ 与 \\theta_i"), "K_s 与 θ_i");
  assert.deepEqual(richRuns("θ_i和R_{i}"), [{ text: "θ", sub: false }, { text: "i", sub: true }, { text: "和R", sub: false }, { text: "i", sub: true }]);
  assert.ok(textWidth("θ_i") < textWidth("θi"));
  const lines = wrapText("S2 计算参考作物蒸散量ET0及实际蒸散量ETa并写入数据库", 300);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => !/^[，。、；]/.test(line)));
  assert.ok(lines.join("").includes("ET0"));
});

test("四类附图都输出黑白、带标记、在图幅内的 SVG", () => {
  const { specs } = extractFigureSpecs(draft([BLOCK, FLOW, LAYERS, STRUCTURE]));
  for (const spec of specs) {
    const figure = renderFigure(spec);
    assert.ok(figure.svg.startsWith("<svg"), `图${spec.no}`);
    assert.ok(figure.widthMm > 20 && figure.widthMm <= MAX_WIDTH_MM && figure.heightMm > 20 && figure.heightMm <= MAX_HEIGHT_MM, `图${spec.no} ${figure.widthMm}×${figure.heightMm}`);
    const colors = [...figure.svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(colors.every((color) => ["#000", "#fff", "none"].includes(color)), `图${spec.no} ${colors.join(",")}`);
    assert.ok(!/<image|rgb\(|opacity/.test(figure.svg));
    assert.deepEqual([...figure.refs].sort(), [...figureSpecRefs(spec)].sort(), `图${spec.no}`);
    assert.ok(figure.fontMm >= 2.8);
    assert.deepEqual(figure.warnings, [], `图${spec.no} ${figure.warnings.join(";")}`);
  }
  const flow = renderFigure(specs[1]);
  assert.ok(flow.texts.includes("否") && flow.texts.includes("是"));
  assert.ok(flow.svg.includes('<tspan dy="9" font-size="25">i</tspan>'));
  assert.equal((flow.svg.match(/<polygon[^>]*fill="#000"/g) ?? []).length, 4);
});

test("内容过多的框图等比缩小并报告字高", () => {
  const nodes = Array.from({ length: 14 }, (_, index) => ({ id: `n${index}`, text: `第${index + 1}个数据采集与处理模块`, ref: String(100 + index) }));
  const spec = normalizeFigureSpec({ no: 1, kind: "block", nodes, edges: nodes.slice(1).map((node) => ({ from: "n0", to: node.id })) }, []);
  assert.ok(spec);
  const figure = renderFigure(spec);
  assert.ok(figure.widthMm <= MAX_WIDTH_MM);
  assert.ok(figure.fontMm < 3.5);
});

test("附图标记列表与正文引用解析", () => {
  const md = "## 具体实施方式\n正文\n### 附图标记\n10—土壤墒情监测单元；20—气象数据获取单元\n30、决策控制器\n40 灌溉执行单元\n## 其他";
  const list = parseReferenceList(referenceSection(md));
  assert.deepEqual(list, [
    { ref: "10", name: "土壤墒情监测单元" },
    { ref: "20", name: "气象数据获取单元" },
    { ref: "30", name: "决策控制器" },
    { ref: "40", name: "灌溉执行单元" },
  ]);
  const refs = textReferences("土壤墒情监测单元10与决策控制器（30）相连，埋深15 cm的传感器20 cm处，电磁阀45控制。");
  assert.deepEqual(refs.map((entry) => entry.ref), ["10", "30", "45"]);
});

test("附图核查：缺图、图号断档、标记三方不一致、步骤缺失都被指出", () => {
  const { specs, issues } = extractFigureSpecs(draft([BLOCK, FLOW]));
  const rendered = specs.map(renderFigure);
  const result = auditFigures({
    figures: [{ no: 1, caption: "系统框图" }, { no: 2, caption: "方法流程图" }, { no: 4, caption: "结构示意图" }],
    abstractFigure: 1,
    specs,
    rendered,
    specIssues: issues,
    referenceList: [
      { ref: "10", name: "土壤墒情监测单元" },
      { ref: "20", name: "气象数据获取单元" },
      { ref: "30", name: "决策控制器" },
      { ref: "50", name: "通信模块" },
    ],
    descriptionText: "土壤墒情监测单元10与决策控制器30连接，通信模块50上传数据，步骤S1、S2、S3、S4、S5依次执行；电磁阀45打开。",
    claimsText: "S1：采集；S5：反馈修正。",
  });
  const byId = new Map(result.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("figure-numbering")?.level, "error");
  assert.match(byId.get("figure-numbering")?.detail ?? "", /缺少图3/);
  assert.equal(byId.get("figure-data")?.level, "error");
  assert.deepEqual(result.missing, [4]);
  assert.equal(byId.get("ref-figure-unlisted")?.level, "error");
  assert.match(byId.get("ref-figure-unlisted")?.detail ?? "", /40/);
  assert.equal(byId.get("ref-list-undrawn")?.level, "error");
  assert.match(byId.get("ref-list-undrawn")?.detail ?? "", /50通信模块/);
  assert.match(byId.get("ref-text-unmentioned")?.detail ?? "", /气象数据获取单元20/);
  assert.match(byId.get("ref-text-unlisted")?.detail ?? "", /电磁阀45/);
  assert.match(byId.get("figure-steps")?.detail ?? "", /S5/);
  assert.equal(byId.get("figure-abstract")?.level, "ok");
  assert.equal(byId.get("figure-form")?.level, "ok");
  assert.ok(result.errorCount >= 4);
});

test("附图核查：一致的申请全部通过", () => {
  const { specs, issues } = extractFigureSpecs(draft([BLOCK, FLOW]));
  const result = auditFigures({
    figures: [{ no: 1, caption: "智能灌溉控制系统的结构框图" }, { no: 2, caption: "智能灌溉控制方法的流程图" }],
    abstractFigure: 2,
    specs,
    rendered: specs.map(renderFigure),
    specIssues: issues,
    referenceList: parseReferenceList("10—土壤墒情监测单元；20—气象数据获取单元；30—决策控制器；40—灌溉执行单元"),
    descriptionText: "如图1所示，土壤墒情监测单元10和气象数据获取单元20分别连接决策控制器30，决策控制器30与灌溉执行单元40双向通信。如图2所示，S1采集，S2计算，S3判断，S4灌溉。",
    claimsText: "S1、S2、S3、S4。",
  });
  const bad = result.checks.filter((check) => check.level !== "ok");
  assert.deepEqual(bad, []);
  assert.deepEqual(result.drawable, [1, 2]);
});

test("栅格化为 300 dpi 白底黑线 PNG", async (t) => {
  let canvas: typeof import("@napi-rs/canvas");
  try {
    canvas = await import("@napi-rs/canvas");
  } catch {
    t.skip("没有 @napi-rs/canvas");
    return;
  }
  const { specs } = extractFigureSpecs(draft([FLOW]));
  const figure = renderFigure(specs[0]);
  const raster = await rasterizeFigure(figure);
  assert.deepEqual([...raster.png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(raster.width, Math.round((figure.widthMm / 25.4) * 300));
  const image = await canvas.loadImage(raster.png);
  const board = canvas.createCanvas(raster.width, raster.height);
  const context = board.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, raster.width, raster.height).data;
  let dark = 0;
  let colored = 0;
  for (let index = 0; index < data.length; index += 4) {
    const [r, g, b] = [data[index], data[index + 1], data[index + 2]];
    if (r < 100 && g < 100 && b < 100) dark += 1;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24) colored += 1;
  }
  assert.equal(colored, 0);
  assert.ok(dark > 2000, `dark ${dark}`);
});

test("附图核查：图中 40a、40b 在列表只列 40 时按 40 的多个实例核对，不阻止导出", () => {
  const { specs, issues } = extractFigureSpecs(draft([BLOCK, FLOW]));
  const block = specs.find((spec) => spec.kind === "block");
  assert.ok(block, "样例应含框图");
  const node40 = block.nodes.find((node) => node.ref === "40");
  assert.ok(node40, "框图样例应含标记 40");
  const patched = specs.map((spec) => (spec === block ? { ...spec, nodes: [...spec.nodes.filter((node) => node !== node40), { ...node40, ref: "40a" }, { ...node40, ref: "40b" }] } : spec));
  const base = {
    figures: [{ no: 1, caption: "智能灌溉控制系统的结构框图" }, { no: 2, caption: "智能灌溉控制方法的流程图" }],
    abstractFigure: 2,
    specs: patched,
    rendered: [],
    specIssues: issues,
    descriptionText: "如图1所示，土壤墒情监测单元10和气象数据获取单元20分别连接决策控制器30，决策控制器30与灌溉执行单元40双向通信。如图2所示，S1采集，S2计算，S3判断，S4灌溉。",
    claimsText: "S1、S2、S3、S4。",
  };
  const listed = auditFigures({ ...base, referenceList: parseReferenceList("10—土壤墒情监测单元；20—气象数据获取单元；30—决策控制器；40—灌溉执行单元") });
  const byId = new Map(listed.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("ref-figure-unlisted"), undefined, JSON.stringify(byId.get("ref-figure-unlisted")));
  assert.equal(byId.get("ref-list-undrawn"), undefined, JSON.stringify(byId.get("ref-list-undrawn")));
  assert.equal(byId.get("ref-instance")?.level, "warn");
  assert.match(byId.get("ref-instance")?.detail ?? "", /40a、40b（图1）按“40灌溉执行单元”的多个实例核对/);
  assert.equal(listed.errorCount, 0, JSON.stringify(listed.checks.filter((check) => check.level === "error")));

  const unlisted = auditFigures({ ...base, referenceList: parseReferenceList("10—土壤墒情监测单元；20—气象数据获取单元；30—决策控制器") });
  const unlistedById = new Map(unlisted.checks.map((check) => [check.id, check]));
  assert.equal(unlistedById.get("ref-figure-unlisted")?.level, "error");
  assert.match(unlistedById.get("ref-figure-unlisted")?.detail ?? "", /40a/);
  assert.equal(unlistedById.get("ref-instance"), undefined);
});

test("附图 PNG 写入 300 dpi 的 pHYs 块，重复写入不叠加，非 PNG 原样返回", () => {
  const chunk = (type: string, data: number[]): number[] => {
    const body = new Uint8Array([...type].map((char) => char.charCodeAt(0)).concat(data));
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(body, 4);
    view.setUint32(8 + data.length, crc32(body));
    return [...out];
  };
  const ihdr = [0, 0, 0, 4, 0, 0, 0, 3, 8, 0, 0, 0, 0];
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk("IHDR", ihdr), ...chunk("IEND", [])]);
  const once = withPngDpi(png, 300);
  const twice = withPngDpi(once, 300);
  assert.deepEqual([...twice], [...once]);
  const view = new DataView(once.buffer, once.byteOffset, once.byteLength);
  const types: string[] = [];
  let offset = 8;
  while (offset < once.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...once.subarray(offset + 4, offset + 8));
    types.push(type);
    assert.equal(view.getUint32(offset + 8 + length), crc32(once.subarray(offset + 4, offset + 8 + length)), `${type} 的 CRC`);
    if (type === "pHYs") {
      assert.equal(view.getUint32(offset + 8), 11811);
      assert.equal(view.getUint32(offset + 12), 11811);
      assert.equal(once[offset + 16], 1);
    }
    offset += 12 + length;
  }
  assert.deepEqual(types, ["IHDR", "pHYs", "IEND"]);
  const notPng = new Uint8Array([1, 2, 3]);
  assert.equal(withPngDpi(notPng, 300), notPng);
});