import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReferenceList } from "./figure-audit.ts";

const names = (text: string) => parseReferenceList(text).map((entry) => entry.ref + "=" + entry.name);

test("附图标记列表：部件名含字母、数字、连字符时完整读出", () => {
  assert.deepEqual(
    names("11—HLA-DR分型模块；12—CD4+T细胞识别单元；13—MHC II类结合预测模块；14—TCR-T细胞制备单元；15—多组学数据采集模块；16—RNA-seq数据处理单元。"),
    ["11=HLA-DR分型模块", "12=CD4+T细胞识别单元", "13=MHCII类结合预测模块", "14=TCR-T细胞制备单元", "15=多组学数据采集模块", "16=RNA-seq数据处理单元"],
  );
  assert.deepEqual(
    names("30—pMHC-II复合物；43—scTCR-seq测序模块；81—第1传感器；82—CD8-T细胞"),
    ["30=pMHC-II复合物", "43=scTCR-seq测序模块", "81=第1传感器", "82=CD8-T细胞"],
  );
  assert.deepEqual(names("- 44：IL-2受体\n- 45：抗PD-1抗体"), ["44=IL-2受体", "45=抗PD-1抗体"]);
});

test("附图标记列表：原有写法结果不变", () => {
  assert.deepEqual(names("10—土壤墒情监测单元；11—第一传感器。"), ["10=土壤墒情监测单元", "11=第一传感器"]);
  assert.deepEqual(names("附图标记：10 土壤墒情监测单元 11 第一传感器"), ["10=土壤墒情监测单元", "11=第一传感器"]);
  assert.deepEqual(names("52、53、54—作物个体；55—TCR-T细胞"), ["52=作物个体", "53=作物个体", "54=作物个体", "55=TCR-T细胞"]);
});
