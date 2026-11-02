/**
 * 生成进度：把流水线已经发出的进度记录（trace 消息）映射成阶段进度。
 *
 * - 只在真实的进度记录出现时前进，不按耗时推算，也不给出百分比估计；
 * - 阶段只进不退：后面的阶段一旦出现，前面的阶段视为已经走过；
 * - 选题、查新、大纲三个阶段可能整段不需要（沿用已有题目、已有查新报告、按材料直写），
 *   被越过而没有出现时标为“已跳过”，不计入总步数；其余阶段是检查类步骤，没有问题时不发记录，被越过即视为完成。
 */
import { AUTO_TRACE_PREFIX } from "./auto-flow.ts";
import type { ChatMessage } from "./model.ts";

export type RunKind = "auto" | "draft";
export type StageStatus = "done" | "active" | "pending" | "skipped";

export interface ProgressStage {
  id: string;
  label: string;
  /** 这一阶段做什么；跳过时是跳过的原因。 */
  hint: string;
  status: StageStatus;
}

export interface RunProgress {
  kind: RunKind;
  title: string;
  stages: ProgressStage[];
  /** 已完成的阶段数（不含跳过的阶段）。 */
  done: number;
  /** 需要执行的阶段数（不含跳过的阶段）。 */
  total: number;
  /** 当前阶段在 stages 中的下标；没有可执行阶段时为 -1。 */
  activeIndex: number;
  activeLabel: string;
  /** 当前阶段在需要执行的阶段中的序号（从 1 起）；没有时为 0。 */
  step: number;
  /** 最新一条进度记录（已压成一行并截短）。 */
  latest: string;
  /** 最新一条进度记录的时间（毫秒）；还没有记录时为 null。 */
  latestAt: number | null;
  /** 最新记录是失败、中断、重试或超时，需要提醒。 */
  attention: boolean;
  /** 本轮的进度记录条数。 */
  traceCount: number;
}

interface StageDef {
  id: string;
  label: string;
  hint: string;
  patterns: RegExp[];
  /** 整段可能不需要的阶段：被越过且没有出现时标为“已跳过”。 */
  skipHint?: string;
}

const WRITE_PATTERNS = [/^正在撰写全文/, /^撰写全文第 \d+ 次失败/, /^初稿/, /^重写/];

const TOPIC: StageDef = {
  id: "topic",
  label: "检索选题",
  hint: "联网检索专利、论文和行业痛点，归纳候选题目并采用最推荐的一个",
  patterns: [/^① 选题/, /^已自动采用推荐题目/, /^选题(?:回复|阶段)/],
  skipHint: "本轮不需要重新选题",
};
const NOVELTY: StageDef = {
  id: "novelty",
  label: "查新对比",
  hint: "多角度检索中国专利，逐项比对技术特征，评估新颖性和创造性风险",
  patterns: [/^①½ 查新/, /^查新第 \d+ 轮/, /^特征比对/],
  skipHint: "已有查新报告，本轮不再重复检索",
};
const OUTLINE: StageDef = {
  id: "outline",
  label: "设计大纲",
  hint: "技术方案、权利要求布局、附图清单和实施例安排",
  patterns: [/^② 大纲/, /^大纲(?:已保存|没有写成)/],
  skipHint: "已有大纲或按材料直写，不单独设计大纲",
};
const SEARCH: StageDef = {
  id: "search",
  label: "检索对比文件",
  hint: "识别技术领域并检索对比文件",
  patterns: [/^发明稿流水线/, /^沿用查新阶段/],
};
const WRITE_AUTO: StageDef = {
  id: "write",
  label: "撰写全文",
  hint: "检索对比文件后写权利要求书、说明书五部分和摘要，全文较长，通常需要一到三分钟",
  patterns: [/^③ 成稿/, /^发明稿流水线/, /^沿用查新阶段/, ...WRITE_PATTERNS],
};
const WRITE_DRAFT: StageDef = {
  id: "write",
  label: "撰写全文",
  hint: "权利要求书、说明书五部分和摘要，全文较长，通常需要一到三分钟",
  patterns: WRITE_PATTERNS,
};
const AUDIT: StageDef = {
  id: "audit",
  label: "自检与修订",
  hint: "领域化自检，发现问题时自动修订一轮",
  patterns: [/^自检 \d+ 分/, /^按 \d+ 项自检问题/, /^修订/],
};
const FIGURES: StageDef = {
  id: "figures",
  label: "附图与形式核查",
  hint: "补绘缺少的附图数据，导出前形式核查并自动修正",
  patterns: [/^附图说明列出的图/, /^补绘/, /^已补绘图/, /^导出前形式核查/, /^形式修正/, /^第 \d+ 轮形式修正/],
};
const POLISH: StageDef = {
  id: "polish",
  label: "审阅与扩写",
  hint: "公式与参数审阅、分节扩写、公开号和摘要字数核对",
  patterns: [
    /^公式与参数专项审阅/,
    /^公式审阅/,
    /^分节扩写/,
    /^正文出现本次检索结果之外/,
    /^说明书摘要 \d+ 字/,
    /^摘要已压缩/,
    /^压缩结果不合格/,
    /^专利号核对/,
  ],
};

const STAGES: Record<RunKind, StageDef[]> = {
  auto: [TOPIC, NOVELTY, OUTLINE, WRITE_AUTO, AUDIT, FIGURES, POLISH],
  draft: [SEARCH, WRITE_DRAFT, AUDIT, FIGURES, POLISH],
};

const TITLES: Record<RunKind, string> = {
  auto: "全自动成稿 · 生成全套申请文件",
  draft: "撰写全套申请文件",
};

/** 本轮开始时间之前这么久以内的记录也算本轮（消息时间和开始时间取自同一台机器，只容忍毫秒级误差）。 */
const CLOCK_SLACK_MS = 1500;
const LATEST_MAX = 140;
const ATTENTION = /失败|中断|重试|超时/;

function stampOf(message: ChatMessage): number {
  const value = Date.parse(message.at);
  return Number.isFinite(value) ? value : Number.NaN;
}

function oneLine(text: string, max = LATEST_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 本轮的进度记录：since 之后的 trace 消息；没有合法时间的消息保留（宁可多算一条，也不漏掉本轮的记录）。 */
export function runTraces(messages: readonly ChatMessage[], since?: number): ChatMessage[] {
  return messages.filter((message) => {
    if (message.role !== "trace") return false;
    if (since === undefined) return true;
    const stamp = stampOf(message);
    return Number.isNaN(stamp) || stamp >= since - CLOCK_SLACK_MS;
  });
}

/** 这一轮要不要显示生成进度：全自动成稿和 /发明稿 显示，其余对话仍用普通的“正在回复”。 */
export function detectRunKind(intent: string, messages: readonly ChatMessage[] = [], since?: number): RunKind | null {
  if (intent === "auto") return "auto";
  if (runTraces(messages, since).some((message) => message.text.trim().startsWith(AUTO_TRACE_PREFIX))) return "auto";
  if (intent === "draft") return "draft";
  return null;
}

export function runProgress(messages: readonly ChatMessage[], options: { kind: RunKind; since?: number }): RunProgress {
  const defs = STAGES[options.kind];
  const traces = runTraces(messages, options.since);
  const planned = new Map<string, string>();
  const seen = new Set<string>();
  let active = -1;

  for (const message of traces) {
    const text = message.text.trim();
    if (options.kind === "auto" && text.startsWith(AUTO_TRACE_PREFIX)) {
      // 全自动成稿的开场白列出本轮要走的步骤：没有“检索选题”就不选题，没有“设计大纲”就不写大纲。
      if (!text.includes("检索选题")) planned.set(TOPIC.id, text.includes("沿用已有题目") ? "沿用已有题目，不重新选题" : "按你提供的材料撰写，不另行选题");
      if (!text.includes("设计大纲")) planned.set(OUTLINE.id, "已有大纲或按材料直写，不单独设计大纲");
      continue;
    }
    for (let index = defs.length - 1; index >= 0; index -= 1) {
      if (defs[index].patterns.some((pattern) => pattern.test(text))) {
        seen.add(defs[index].id);
        if (index > active) active = index;
        break;
      }
    }
  }

  const stages: ProgressStage[] = defs.map((def, index) => {
    if (seen.has(def.id)) {
      return { id: def.id, label: def.label, hint: def.hint, status: index === active ? "active" : "done" };
    }
    const plannedSkip = planned.get(def.id);
    if (plannedSkip !== undefined) return { id: def.id, label: def.label, hint: plannedSkip, status: "skipped" };
    if (active >= 0 && index < active) {
      return def.skipHint !== undefined
        ? { id: def.id, label: def.label, hint: def.skipHint, status: "skipped" }
        : { id: def.id, label: def.label, hint: def.hint, status: "done" };
    }
    return { id: def.id, label: def.label, hint: def.hint, status: "pending" };
  });

  // 还没有任何阶段记录：流水线一开始就在第一个要执行的阶段上。
  if (active < 0) {
    active = stages.findIndex((stage) => stage.status !== "skipped");
    if (active >= 0) stages[active] = { ...stages[active], status: "active" };
  }

  const counted = stages.filter((stage) => stage.status !== "skipped");
  const last = traces.at(-1);
  const latest = last ? oneLine(last.text) : "";
  const latestStamp = last ? stampOf(last) : Number.NaN;
  return {
    kind: options.kind,
    title: TITLES[options.kind],
    stages,
    done: counted.filter((stage) => stage.status === "done").length,
    total: counted.length,
    activeIndex: active,
    activeLabel: active >= 0 ? stages[active].label : "",
    step: active >= 0 ? counted.indexOf(stages[active]) + 1 : 0,
    latest,
    latestAt: Number.isNaN(latestStamp) ? null : latestStamp,
    attention: ATTENTION.test(latest),
    traceCount: traces.length,
  };
}

/** 耗时的中文写法：45 秒、2 分 05 秒、1 小时 03 分。负数和非数字按 0 处理。 */
export function formatElapsed(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, "0")} 分`;
}