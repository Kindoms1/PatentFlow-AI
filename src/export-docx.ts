/**
 * Word export in the layout of a CNIPA invention filing (发明专利申请文件).
 *
 * Order follows the filing package: 说明书摘要 → 摘要附图 → 权利要求书 → 说明书 → 说明书附图, each part in its own
 * Word section with its own header and its own page numbering (current / pages in this part). Page is A4 with
 * 25 mm top/left and 15 mm bottom/right margins, 宋体 小四, 1.5 line spacing, 说明书 paragraphs numbered [0001].
 * A final “内部审核单” section carries the formal check, request-form items, pending marks and the drafting audit;
 * it is clearly marked for deletion before filing. The output is a base draft for an agent's review, not an
 * official document, and nothing here guarantees acceptance by CNIPA.
 */
import { AlignmentType, BorderStyle, Document, Footer, ImageRun, Header, NumberFormat, Packer, PageNumber, Paragraph, ShadingType, Tab, TabStopType, Table, TableCell, TableRow, TextRun, WidthType, XmlComponent, type ParagraphChild } from "docx";
import type { ISectionOptions } from "docx";
import { formalCheck, parseApplication } from "./cnipa-format.ts";
import type { CheckLevel, FormalReport, ParsedApplication } from "./cnipa-format.ts";
import { LEVEL_LABEL } from "./model.ts";
import type { InventionDraftState, PatentCase } from "./model.ts";
import { Math as OMath, latexToMath } from "docx/math";
import { parseDisplayLine, plainParagraph, splitMath, texToPlain } from "./formula.ts";
import type { SymbolDef } from "./formula-audit.ts";
import { backgroundArtDetail, citedPriorArt } from "./invention-draft.ts";
import { cachedFigureImages, drawableFigures, ensureFigureImages } from "./figure-assets.ts";
import type { FigureImage } from "./figure-assets.ts";
import { FIGURE_KIND_LABEL } from "./figure-spec.ts";
import { pendingItemText } from "./draft-polish.ts";

type Align = (typeof AlignmentType)[keyof typeof AlignmentType];
type Block = Paragraph | Table;

export const EXPORT_DISCLAIMER =
  "本稿由 PatentFlow 依据发明人提供的材料生成，是供专利代理师和申请人审核的发明专利申请文件基础初稿，不构成法律意见，不等同于正式申请文件，也不保证被国家知识产权局受理或授权。正式提交前，请由专利代理师或申请人对照现行《专利法》《专利法实施细则》《专利审查指南》和国家知识产权局专利业务办理系统的要求，核实技术内容、保护范围和格式。";

const mm = (value: number) => Math.round((value * 1440) / 25.4);
const PAGE_SIZE = { width: 11906, height: 16838 };
const PAGE_MARGIN = { top: mm(25), left: mm(25), bottom: mm(15), right: mm(15), header: mm(12), footer: mm(6) };
const FONT = { ascii: "Times New Roman", hAnsi: "Times New Roman", cs: "Times New Roman", eastAsia: "宋体" };
const SIZE = { body: 24, title: 32, header: 28, small: 21, note: 18 };
const LINE = 360;
const INDENT = 480;
const GRAY = "667085";
const RED = "B42318";
const LEVEL_TEXT: Record<CheckLevel, string> = { error: "需修改", warn: "需注意", ok: "通过" };
const LEVEL_COLOR: Record<CheckLevel, string> = { error: RED, warn: "B54708", ok: "067647" };

interface RunOpts {
  bold?: boolean;
  size?: number;
  color?: string;
  italics?: boolean;
  breakBefore?: number;
}

function run(text: string, opts: RunOpts = {}): TextRun {
  return new TextRun({ text, font: FONT, size: opts.size ?? SIZE.body, bold: opts.bold, italics: opts.italics, color: opts.color, break: opts.breakBefore });
}

interface ParaOpts extends RunOpts {
  align?: Align;
  indent?: boolean;
  before?: number;
  after?: number;
  keepNext?: boolean;
}

type Inline = TextRun | OMath;

/** Width of the text block between the page margins, in twips. */
const TEXT_WIDTH = PAGE_SIZE.width - PAGE_MARGIN.left - PAGE_MARGIN.right;

/** A LaTeX formula as a native Word equation (OMML); text in italics when the formula cannot be converted. */
function mathOf(tex: string): Inline {
  try {
    const children = latexToMath(tex);
    if (children.length) return new OMath({ children });
    return run(texToPlain(tex), { italics: true });
  } catch {
    return run(texToPlain(tex), { italics: true });
  }
}

/** Text with $…$ formulas as Word runs: words keep the body font, formulas become native equations. */
function richRuns(text: string, opts: RunOpts = {}): Inline[] {
  const out: Inline[] = [];
  for (const segment of splitMath(text)) {
    if (segment.kind === "text") {
      if (segment.value) out.push(run(segment.value, opts));
    } else {
      out.push(mathOf(segment.tex));
    }
  }
  return out.length ? out : [run("", opts)];
}

/**
 * Word 显示公式段落 `m:oMathPara`：公式独占一行，由 Word 按显示模式排版并居中。
 * docx 库没有提供这个元素，这里用 XmlComponent 包一层 m:oMath。
 */
class MathParagraph extends XmlComponent {
  public constructor(math: OMath) {
    super("m:oMathPara");
    this.root.push(math);
  }
}

/**
 * 独立公式。无编号的公式（如权利要求中的公式）导出为 Word 显示公式 `m:oMathPara`。
 * 有编号的公式按申请文件惯例，用居中制表位放公式、右对齐制表位放编号（n）。
 * latexToMath 会显式写出 `m:limLoc`，所以 ∑ 的上下限在这种排法里仍位于符号正上方和正下方。
 */
function formulaPara(tex: string, label: string | null): Paragraph {
  const math = mathOf(tex);
  if (!label) {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { line: LINE, before: 60, after: 60 },
      children: [math instanceof OMath ? (new MathParagraph(math) as unknown as ParagraphChild) : math],
    });
  }
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { line: LINE, before: 60, after: 60 },
    tabStops: [
      { type: TabStopType.CENTER, position: Math.round(TEXT_WIDTH / 2) },
      { type: TabStopType.RIGHT, position: TEXT_WIDTH },
    ],
    children: [
      new TextRun({ children: [new Tab()], font: FONT, size: SIZE.body }),
      math,
      new TextRun({ children: [new Tab(), `（${label}）`], font: FONT, size: SIZE.body }),
    ],
  });
}

function para(content: string | Inline[], opts: ParaOpts = {}): Paragraph {
  return new Paragraph({
    alignment: opts.align ?? AlignmentType.JUSTIFIED,
    indent: opts.indent ? { firstLine: INDENT } : undefined,
    spacing: { line: LINE, before: opts.before ?? 0, after: opts.after ?? 0 },
    keepNext: opts.keepNext,
    children: typeof content === "string" ? richRuns(content, opts) : content,
  });
}

function heading(text: string): Paragraph {
  return para(text, { bold: true, align: AlignmentType.LEFT, before: 200, after: 80, keepNext: true });
}

/** “说明书” → “说　明　书”, the way part names are set on the official forms. */
function spaced(name: string): string {
  return [...name].length <= 5 ? [...name].join("　") : name;
}

function partHeader(name: string, note?: string): Header {
  const children = [new Paragraph({ alignment: AlignmentType.CENTER, children: [run(spaced(name), { bold: true, size: SIZE.header })] })];
  if (note) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [run(note, { size: SIZE.note })] }));
  return new Header({ children });
}

function pageFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE.small })],
      }),
    ],
  });
}

function section(name: string, children: Block[], note?: string): ISectionOptions {
  return {
    properties: { page: { size: PAGE_SIZE, margin: PAGE_MARGIN, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } } },
    headers: { default: partHeader(name, note) },
    footers: { default: pageFooter() },
    children,
  };
}

/** 空白虚线框的行数（单倍行距）：框高约 5～6 cm，能看出图位，又不留大片空白。 */
const FIGURE_BOX_LINES = 10;

/**
 * 附图暂缺时的空白虚线框。正式申请文件里不写任何说明文字、不用审核颜色，缺图原因只记在内部审核单。
 * 整框是一个段落：keepLines 禁止跨页拆开，keepNext 让它与下方图号同页。
 */
function figureBox(): Paragraph {
  const edge = { style: BorderStyle.DASHED, size: 6, color: "000000", space: 6 };
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    keepNext: true,
    keepLines: true,
    border: { top: edge, bottom: edge, left: edge, right: edge },
    spacing: { before: 120, after: 120, line: 240 },
    children: [run("", { breakBefore: FIGURE_BOX_LINES })],
  });
}

/**
 * 一幅附图：有图像时嵌入黑白线条图（SVG 矢量图，旧版 Word 显示 PNG 回退图），按实际图幅尺寸排版；
 * 没有图像时放不可拆分的空白虚线框，缺图原因见内部审核单。
 */
function figureBlocks(no: number, images: Map<number, FigureImage>, caption: string): Paragraph[] {
  const image = images.get(no);
  if (!image) return [figureBox()];
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      keepNext: true,
      // 单倍行距：1.5 倍行距会把整幅图所在的行一并放大
      spacing: { line: 240, before: 120, after: 120 },
      children: [
        new ImageRun({
          type: "svg",
          data: image.svg,
          fallback: { type: "png", data: image.png },
          transformation: { width: image.displayWidth, height: image.displayHeight },
          altText: { name: `图${no}`, title: `图${no}`, description: caption || `图${no}` },
        }),
      ],
    }),
  ];
}

type Cell = string | { text: string; color?: string; bold?: boolean };

function table(head: string[], rows: Cell[][], widths: number[]): Table {
  const cell = (value: Cell, index: number, isHead: boolean) => {
    const data = typeof value === "string" ? { text: value } : value;
    return new TableCell({
      width: { size: widths[index] ?? Math.floor(100 / head.length), type: WidthType.PERCENTAGE },
      shading: isHead ? { type: ShadingType.CLEAR, color: "auto", fill: "EEF2F7" } : undefined,
      children: [new Paragraph({ spacing: { line: 300 }, children: [run(data.text || "—", { size: SIZE.small, bold: isHead || data.bold, color: data.color })] })],
    });
  };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: head.map((value, index) => cell(value, index, true)) }),
      ...rows.map((row) => new TableRow({ children: row.map((value, index) => cell(value, index, false)) })),
    ],
  });
}

function abstractSection(app: ParsedApplication): ISectionOptions {
  const children = app.abstract.length ? app.abstract.map((text) => para(text, { indent: true })) : [para("", { indent: true })];
  return section("说明书摘要", children);
}

function abstractFigureSection(app: ParsedApplication): ISectionOptions | null {
  if (!app.figures.length) return null;
  const no = app.abstractFigure && app.figures.some((figure) => figure.no === app.abstractFigure) ? app.abstractFigure : app.figures[0].no;
  const caption = app.figures.find((figure) => figure.no === no)?.caption ?? "";
  return section("摘要附图", [...figureBlocks(no, cachedFigureImages(app), caption), para(`图${no}`, { align: AlignmentType.CENTER })]);
}

function claimsSection(app: ParsedApplication): ISectionOptions {
  const children: Block[] = [];
  for (const claim of app.claims) {
    const [first = "", ...rest] = claim.lines;
    children.push(para(`${claim.no}.${first}`, { indent: true }));
    for (const line of rest) {
      const display = parseDisplayLine(line);
      children.push(display ? formulaPara(display.tex, null) : para(line, { indent: true }));
    }
  }
  return section("权利要求书", children);
}

function descriptionSection(app: ParsedApplication): ISectionOptions {
  const children: Block[] = app.title ? [para(app.title, { align: AlignmentType.CENTER, bold: true, size: SIZE.title, after: 240 })] : [];
  let counter = 0;
  for (const part of app.description) {
    if (!part.paragraphs.length) continue;
    children.push(heading(part.heading));
    for (const item of part.paragraphs) {
      if (item.sub) {
        children.push(para(item.text, { bold: true, align: AlignmentType.LEFT, indent: true, keepNext: true }));
        continue;
      }
      if (item.formula) {
        children.push(formulaPara(item.formula.tex, item.formula.label));
        continue;
      }
      counter += 1;
      children.push(para([run(`[${String(counter).padStart(4, "0")}]`), ...richRuns(`　${item.text}`)]));
    }
  }
  return section("说明书", children);
}

function drawingsSection(app: ParsedApplication): ISectionOptions | null {
  if (!app.figures.length) return null;
  const images = cachedFigureImages(app);
  const children = app.figures.flatMap((figure) => [
    ...figureBlocks(figure.no, images, figure.caption),
    para(`图${figure.no}`, { align: AlignmentType.CENTER, after: 240 }),
  ]);
  return section("说明书附图", children);
}

const REQUEST_ITEMS = [
  "申请人（姓名或名称、地址、邮政编码、证件号码或统一社会信用代码）",
  "发明人（应为自然人）及第一发明人证件号码",
  "联系人及联系方式",
  "专利代理机构及专利代理师（委托代理时）",
  "要求优先权声明（在先申请的国家或地区、申请日、申请号）",
  "不丧失新颖性宽限期声明（如适用）",
  "是否请求提前公布",
  "是否同时提出实质审查请求",
  "费用减缴请求（如适用）",
  "生物材料保藏、遗传资源来源披露（如涉及）",
];

const SUBMIT_CHECKLIST = [
  "权利要求每项一句话、只在结尾用句号；独立权利要求只写解决技术问题的必要技术特征；从属权利要求只引用在前的权利要求。",
  "说明书与权利要求术语一致，权利要求的每一个技术特征都能在说明书中找到依据。",
  "附图用黑色线条绘制、图号连续，除必需的词语外不含其他注释；摘要附图选自说明书附图。",
  "对照本审核单“待补充事实”逐项补充真实参数和实验数据，替换正式文件中“根据实际应用需求确定”“以实际测试记录为准”等概括表述，补充内容不得超出发明人原始材料的记载；空白虚线框附图补绘后替换。",
  "背景技术引用的对比文件已在国家知识产权局或公开专利数据库核实公开号和内容。",
  "计量单位采用国家法定计量单位，数学式、化学式书写规范。",
  "本审核单整节删除后，再按专利业务办理系统要求分别上传各部分文件。",
];

export interface ApplicationExportOptions {
  /** The drafting run's own audit, printed on the review sheet. */
  draft?: InventionDraftState;
  /** A knowledge-library sample: fictional content, labelled as such. */
  sample?: boolean;
  fileStem?: string;
  /** 合订稿末尾附内部审核单。默认不附：正式申请文件不含任何审核内容，审核单单独导出。 */
  includeReview?: boolean;
}

function reviewSection(app: ParsedApplication, report: FormalReport, options: ApplicationExportOptions): ISectionOptions {
  const children: Block[] = [
    para("内部审核单", { align: AlignmentType.CENTER, bold: true, size: SIZE.title, after: 160 }),
    para("本审核单不是申请文件内容，只供内部审核使用，不要提交或上传。正式申请文件（各分件与合订稿）中不含审核提示。", { bold: true, color: RED, after: 120 }),
    para(EXPORT_DISCLAIMER, { indent: true, after: 120 }),
  ];
  if (options.sample) {
    children.push(para("这是 PatentFlow 知识库中的示范样例，技术内容为虚构，只用于学习申请文件的结构和写法，不对应任何真实专利或申请。", { bold: true, color: RED, after: 120 }));
  }

  children.push(heading("一、形式检查结果"));
  children.push(para(report.errors || report.warnings ? `${report.errors} 项需修改，${report.warnings} 项需注意。` : "可自动判断的形式项全部通过，仍需人工审核实质内容。", { after: 80 }));
  children.push(table(["检查项", "结果", "说明"], report.checks.map((check) => [check.label, { text: LEVEL_TEXT[check.level], color: LEVEL_COLOR[check.level], bold: true }, check.detail]), [26, 12, 62]));
  const formulas = report.formulas;
  if (formulas?.applicable) {
    const display = formulas.formulas.filter((item) => item.display).length;
    const inline = formulas.formulas.length - display;
    children.push(para(`公式与符号一览：独立公式 ${display} 个，行内公式 ${inline} 处${formulas.plainFormulaCount ? `，另有 ${formulas.plainFormulaCount} 处以普通文字书写（未生成 Word 公式）` : ""}。`, { bold: true, before: 120, after: 80 }));
    const symbols = firstDefinitions(formulas.symbols);
    if (symbols.length) children.push(table(["符号", "含义", "单位", "定义位置"], symbols.slice(0, 80).map((item) => [item.key, reviewPlain(item.meaning), item.unit || "—", item.where]), [16, 46, 16, 22]));
    const problems = formulas.issues.slice(0, 30);
    if (problems.length) {
      children.push(para("公式与符号问题明细：", { bold: true, before: 120, after: 80 }));
      problems.forEach((item, index) => children.push(para(`${index + 1}. 【${item.level === "error" ? "需修改" : "需注意"}】${reviewPlain(item.detail)}`, { color: item.level === "error" ? RED : undefined })));
    }
  }

  if (app.figures.length) {
    const drawn = drawableFigures(app);
    children.push(para(`附图一览：附图说明列出 ${app.figures.length} 幅，按绘图数据绘制 ${drawn.length} 幅${drawn.length < app.figures.length ? `，${app.figures.length - drawn.length} 幅缺少绘图数据（正式文件中为空白虚线框）` : ""}。`, { bold: true, before: 120, after: 80 }));
    children.push(
      table(
        ["图号", "类型", "图名", "图幅（mm）", "字高（mm）", "附图标记"],
        app.figures.map((figure) => {
          const rendered = drawn.find((item) => item.no === figure.no);
          return [
            `图${figure.no}`,
            rendered ? FIGURE_KIND_LABEL[rendered.kind] : { text: "缺少绘图数据", color: LEVEL_COLOR.warn },
            figure.caption,
            rendered ? `${rendered.widthMm}×${rendered.heightMm}` : "—",
            rendered ? String(rendered.fontMm) : "—",
            rendered?.refs.length ? rendered.refs.join("、") : "—",
          ];
        }),
        [9, 14, 35, 15, 11, 16],
      ),
    );
  }

  const pictured = cachedFigureImages(app);
  const missingFigures = app.figures.filter((figure) => !pictured.has(figure.no));
  if (missingFigures.length) {
    children.push(para("附图待补：以下附图在正式申请文件中暂为空白虚线框，补绘后替换：", { bold: true, before: 120, after: 80 }));
    missingFigures.forEach((figure, index) => {
      const hasData = (app.figureSpecs ?? []).some((spec) => spec.no === figure.no);
      const reason = hasData ? "已有绘图数据，但本次导出未能生成图像，请重新导出" : "缺少绘图数据，请按附图说明用黑色线条绘制";
      children.push(para(`${index + 1}. 图${figure.no}${figure.caption ? `（${reviewPlain(figure.caption)}）` : ""}：${reason}。`));
    });
  }

  children.push(heading("二、文本统计"));
  children.push(
    table(
      ["项目", "数值"],
      [
        ["发明名称", `${app.title || "—"}（${report.stats.titleChars} 字）`],
        ["说明书摘要", `${report.stats.abstractChars} 字`],
        ["权利要求", `${report.stats.claimCount} 项（独立 ${report.stats.independentCount} 项）`],
        ["说明书正文", `${report.stats.descriptionChars} 字`],
        ["附图", `${report.stats.figureCount} 幅`],
        ["待补充事实", `${report.stats.pendingCount} 处`],
        ["推断与示例值核验", `${(app.reviewAnnotations ?? []).length} 处（示例值的非实测性质保留在正文）`],
      ],
      [30, 70],
    ),
  );

  children.push(heading("三、请求书信息（在专利业务办理系统中另行填写）"));
  children.push(table(["项目", "内容"], [["发明名称", app.title || "—"], ...REQUEST_ITEMS.map((item) => [item, "在专利业务办理系统中填写"])], [45, 55]));

  children.push(heading("四、待补充事实"));
  const annotations = app.reviewAnnotations ?? [];
  if (app.pendingMarks.length) app.pendingMarks.slice(0, 40).forEach((mark, index) => children.push(para(`${index + 1}. ${pendingItemText(mark)}`)));
  else if (!annotations.length) children.push(para("无。"));
  if (annotations.length) {
    children.push(para(`推断与示例值核验（共 ${annotations.length} 处，示例值在正文中仍明确为非实测数据，提交前须逐项核实）：`, { bold: true, before: 120, after: 80 }));
    annotations.forEach((item, index) => children.push(para(`${index + 1}. ${reviewPlain(item)}`)));
  }
  const draft = options.draft;
  if (draft) {
    children.push(heading("五、生成时的实质自检"));
    children.push(para(`自检 ${draft.score} 分，${draft.claimCount} 项权利要求，${draft.revised ? "已按自检结果自动修订一轮" : "未修订"}。模型：${draft.model || "—"}；生成时间：${draft.at}。`, { after: 80 }));
    const background = app.description.find((part) => part.heading === "背景技术")?.paragraphs.map((item) => item.text).join("\n") ?? "";
    const citation = citedPriorArt(background, draft.priorArt.map((ref) => ref.pn));
    // 旧稿保存的自检结果把检索结果之外的公开号也算作有效引用：导出时按本次检索结果重新判断
    const checks = draft.checks.map((check) => (check.label === "背景技术引用对比文件" ? { ...check, ok: citation.valid.length > 0, detail: backgroundArtDetail(citation.valid, citation.unverified) } : check));
    if (checks.length) children.push(table(["自检项", "结果", "说明"], checks.map((check) => [check.label, { text: check.ok ? "通过" : "未通过", color: check.ok ? LEVEL_COLOR.ok : LEVEL_COLOR.warn, bold: true }, check.detail]), [30, 12, 58]));
    if (draft.distinguishing.length) {
      children.push(para("区别技术特征（创造性论证的依据）：", { bold: true, before: 120, after: 80 }));
      children.push(table(["区别特征", "解决的技术问题", "技术效果"], draft.distinguishing.map((row) => [row.feature, row.problem, row.effect]), [40, 30, 30]));
    }
    if (draft.pending.length) {
      children.push(para("需要发明人补充确认：", { bold: true, before: 120 }));
      draft.pending.forEach((item, index) => children.push(para(`${index + 1}. ${reviewPlain(item)}`)));
    }
    if (draft.priorArt.length) {
      children.push(para("检索到的对比文件（公开网页线索，需核实）：", { bold: true, before: 120, after: 80 }));
      children.push(table(["公开号", "名称", "链接"], draft.priorArt.map((ref) => [ref.pn, ref.title, ref.url]), [22, 38, 40]));
    }
    if (citation.unverified.length) {
      children.push(para(`背景技术中的 ${citation.unverified.join("、")} 不在本次检索结果中，说明书中已标注“待核实”，不计为对比文件；提交前请到国家知识产权局系统核实，无法核实的请删除。`, { color: RED, before: 80 }));
    }
    const review = draft.mathReview;
    if (review) {
      const head = review.accepted && review.applied.length
        ? `公式与参数专项审阅：采用 ${review.applied.length} 处定点修改${review.skipped.length ? `，另有 ${review.skipped.length} 条建议无法在原文中唯一定位，未套用` : ""}。`
        : review.applied.length
          ? "公式与参数专项审阅：给出的修改会带来新的形式问题，已整体放弃，保留原稿。"
          : "公式与参数专项审阅：没有需要套用的修改。";
      children.push(para(head, { bold: true, before: 120, after: 80 }));
      if (review.accepted && review.applied.length) {
        children.push(table(["原文", "修改为", "理由"], review.applied.slice(0, 40).map((item) => [clip(reviewPlain(item.find)), clip(reviewPlain(item.replace)), reviewPlain(item.reason)]), [34, 34, 32]));
      }
      if (review.notes.length) {
        children.push(para("公式与参数中需要发明人确认的问题：", { bold: true, before: 120 }));
        review.notes.forEach((note, index) => children.push(para(`${index + 1}. ${reviewPlain(note)}`)));
      }
    }
  }

  children.push(heading(draft ? "六、提交前核对清单" : "五、提交前核对清单"));
  SUBMIT_CHECKLIST.forEach((item, index) => children.push(para(`${index + 1}. ${item}`)));

  return section("内部审核单（非申请文件，不提交）", children);
}

/** Runs of text outside CJK characters and full-width punctuation: where a bare LaTeX fragment can sit inside a Chinese sentence. */
const NON_CJK_RUN = /[^\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/gu;
const TEX_COMMAND = /\\[A-Za-z]+/;

/** One command in readable form, used when a fragment cannot be read as a whole (unbalanced braces, a cut-off formula). */
function plainCommand(command: string): string {
  try {
    const plain = texToPlain(command);
    return TEX_COMMAND.test(plain) ? command.slice(1) : plain;
  } catch {
    return command.slice(1);
  }
}

/**
 * Review-sheet text in readable form. Delimited math goes through plainParagraph; a bare LaTeX fragment quoted from
 * inside a formula (a math-review patch, a note, an issue detail) has no delimiters, so each non-CJK run that still
 * carries a command is converted with texToPlain. The review sheet is plain text: no LaTeX command reaches Word.
 */
export function reviewPlain(text: string): string {
  const base = plainParagraph(text);
  if (!TEX_COMMAND.test(base)) return base;
  return base.replace(NON_CJK_RUN, (run) => {
    if (!TEX_COMMAND.test(run)) return run;
    const lead = /^\s*/.exec(run)?.[0] ?? "";
    const tail = /\s*$/.exec(run)?.[0] ?? "";
    const core = run.trim();
    let plain = "";
    try {
      plain = texToPlain(core);
    } catch {
      plain = "";
    }
    if (!plain.trim() || TEX_COMMAND.test(plain)) {
      plain = core
        .replace(/\\(?:left|right|big|Big|bigg|Bigg)(?![A-Za-z])/g, "")
        .replace(/\\(?:mathrm|mathit|mathbf|operatorname|text)\s*\{([^{}]*)\}/g, "$1")
        .replace(/\\[A-Za-z]+/g, plainCommand)
        .replace(/[{}]/g, "");
    }
    return lead + plain + tail;
  });
}

function clip(text: string, cap = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

/** One definition per symbol for the review sheet: a symbol table or “X为……” wins over a term written beside it. */
function firstDefinitions(symbols: SymbolDef[]): SymbolDef[] {
  const rank = { table: 0, explicit: 1, term: 2 } as const;
  const best = new Map<string, SymbolDef>();
  for (const item of symbols) {
    const current = best.get(item.key);
    if (!current || rank[item.kind] < rank[current.kind] || (!current.unit && item.unit && rank[item.kind] === rank[current.kind])) best.set(item.key, item.unit || !current ? item : { ...item, unit: current.unit });
  }
  return [...best.values()];
}

/** The whole filing package as a docx Document (pure: safe to call in tests and in node). */
export function buildApplicationDocument(app: ParsedApplication, report: FormalReport, options: ApplicationExportOptions = {}): Document {
  const sections: ISectionOptions[] = [abstractSection(app)];
  const abstractFigure = abstractFigureSection(app);
  if (abstractFigure) sections.push(abstractFigure);
  sections.push(claimsSection(app), descriptionSection(app));
  const drawings = drawingsSection(app);
  if (drawings) sections.push(drawings);
  // 正式申请文件默认不带审核内容；只有显式要求时才把内部审核单附在末尾
  if (options.includeReview) sections.push(reviewSection(app, report, options));
  return new Document({
    creator: "PatentFlow",
    title: app.title || "发明专利申请文件草稿",
    description: "发明专利申请文件基础初稿（待专利代理师审核，不是正式申请文件）",
    styles: { default: { document: { run: { font: FONT, size: SIZE.body }, paragraph: { spacing: { line: LINE } } } } },
    sections,
  });
}

/** True when a text is a full application draft (as opposed to an older free-form disclosure). */
export function looksLikeApplication(text: string): boolean {
  if (!text.trim()) return false;
  return /^#\s*发明名称/m.test(text) || (/^#{2,3}\s*权利要求书/m.test(text) && /^#{2,3}\s*具体实施方式/m.test(text));
}

export function prepareApplication(markdown: string, fallbackTitle: string): { app: ParsedApplication; report: FormalReport } {
  const app = parseApplication(markdown, fallbackTitle);
  return { app, report: formalCheck(app) };
}

function safeName(value: string): string {
  const clean = value.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return clean || "发明专利申请文件";
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Validate, build and download a filing-format docx from a markdown application draft. */
export async function downloadApplication(markdown: string, fallbackTitle: string, options: ApplicationExportOptions = {}): Promise<FormalReport> {
  const { app, report } = prepareApplication(markdown, fallbackTitle);
  // 附图图像先异步生成并缓存，下面同步构建 Word 时嵌入
  if (report.exportable) await ensureFigureImages(app);
  if (!report.exportable) throw new Error(report.fatal);
  const blob = await Packer.toBlob(buildApplicationDocument(app, report, options));
  const stem = safeName(options.fileStem || app.title || fallbackTitle);
  saveBlob(blob, `${stem}-${options.sample ? "示范样例" : "发明专利申请文件草稿"}.docx`);
  return report;
}

/** Older cases hold a free-form disclosure rather than a full application: export it as a plain review copy. */
async function downloadLegacy(patentCase: PatentCase): Promise<void> {
  const children: Block[] = [
    para(patentCase.title, { align: AlignmentType.CENTER, bold: true, size: SIZE.title, after: 120 }),
    para("交底草稿 · 不构成法律意见 · 不是正式申请文件。生成完整申请文件请在对话中发送 /发明稿。", { color: GRAY, after: 200 }),
  ];
  for (const line of patentCase.disclosure.split("\n")) {
    if (line.startsWith("# ")) continue;
    if (line.startsWith("## ")) children.push(heading(line.slice(3)));
    else if (line.trim()) children.push(para(line.replace(/^- /, ""), { indent: true }));
  }
  children.push(heading("权利要求草稿"));
  if (!patentCase.claims.length) children.push(para("尚未生成权利要求。"));
  patentCase.claims.forEach((claim) => children.push(para(`${claim.no}.${claim.text}`, { indent: true })));
  children.push(heading("问题清单"));
  if (!patentCase.issues.length) children.push(para("无。"));
  patentCase.issues.forEach((issue) => children.push(para(`【${LEVEL_LABEL[issue.level]}】${issue.title}：${issue.detail}`)));
  children.push(para(EXPORT_DISCLAIMER, { color: GRAY, before: 200 }));
  const document = new Document({
    creator: "PatentFlow",
    title: patentCase.title,
    styles: { default: { document: { run: { font: FONT, size: SIZE.body }, paragraph: { spacing: { line: LINE } } } } },
    sections: [section("交底草稿", children)],
  });
  saveBlob(await Packer.toBlob(document), `${safeName(patentCase.title)}-交底草稿.docx`);
}

/**
 * Export a case. A full application draft (from /发明稿) goes out in filing layout with its formal check;
 * an older disclosure falls back to a plain review copy and returns null.
 */
export async function downloadDisclosure(patentCase: PatentCase): Promise<FormalReport | null> {
  const source = patentCase.inventionDraft?.text?.trim() || (looksLikeApplication(patentCase.disclosure) ? patentCase.disclosure : "");
  if (source) return downloadApplication(source, patentCase.title, { draft: patentCase.inventionDraft });
  await downloadLegacy(patentCase);
  return null;
}

export { abstractSection, abstractFigureSection, claimsSection, descriptionSection, drawingsSection, reviewSection, section, para, table, heading, REQUEST_ITEMS, SUBMIT_CHECKLIST, FONT, SIZE, LINE, RED, GRAY };
