/**
 * The plain-language layer: everything the editor shows a beginner in Chinese.
 *
 * The rule language, the field paths, and the operators stay English — they are
 * data. This module only wraps them in words a first-time user can read, and
 * turns a rule back into one sentence ("这条规则的意思是：…") so the form and
 * the meaning are always visible together.
 */

import type { Condition, JsonValue, ScalarOp, When } from "../../../src/regimen/predicate.ts";
import type { Rule } from "../../../src/regimen/rule.ts";
import { EVENT_TYPES, allFields, fieldFor } from "../../../src/editor/catalog.ts";

/* ── levels ──────────────────────────────────────────────────────────────── */

export function zhLevel(level: string | undefined): string {
  switch (level) {
    case "high":
      return "严重";
    case "medium":
      return "警告";
    case "low":
      return "提示";
    default:
      return "无异常";
  }
}

/* ── event types ─────────────────────────────────────────────────────────── */

const ZH_EVENT: Record<string, string> = {
  message: "消息",
  thinking: "思考",
  command: "命令",
  tool_start: "工具开始",
  tool_update: "工具输出",
  tool_end: "工具结束",
  file_read: "读文件",
  file_write: "写文件",
  file_edit: "改文件",
  file_change: "文件变动",
  search: "搜索",
  process: "进程",
  mcp: "MCP 调用",
  approval: "等待批准",
  error: "错误",
  agent_start: "代理启动",
  agent_end: "代理结束",
};

export function zhEventLabel(type: string): string {
  return ZH_EVENT[type] ?? type;
}

export function eventOptions(): Array<{ type: string; label: string; hint?: string }> {
  return EVENT_TYPES.map((info) => ({ type: info.type, label: `${ZH_EVENT[info.type] ?? info.label} ${info.type}`, hint: info.hint }));
}

/* ── fields ──────────────────────────────────────────────────────────────── */

/** Chinese names for the field paths a beginner is most likely to touch. */
const ZH_FIELD: Record<string, string> = {
  "facts.run.id": "运行 id",
  "facts.run.status": "运行状态",
  "facts.run.durationMs": "运行时长（毫秒）",
  "facts.run.startedAt": "开始时间",
  "facts.run.endedAt": "结束时间",
  "facts.ended": "这一轮是否已结束",
  "facts.commands.failed": "失败命令数",
  "facts.commands.total": "命令总数",
  "facts.commands.succeeded": "成功命令数",
  "facts.commands.running": "仍在运行的命令数",
  "facts.commands.unknown": "结果未知的命令数",
  "facts.failureStreak.count": "最长连败次数",
  "facts.errors.total": "错误事件数",
  "facts.unresolved": "未恢复的失败",
  "facts.retries": "反复失败的命令",
  "facts.recoveries": "已恢复的失败",
  "facts.reverts": "被改回去的文件",
  "facts.outsideChanges": "项目外的改动",
  "facts.response": "代理最后的回复",
  "facts.currentPhase": "当前阶段",
  "facts.lastActivityAt": "最后活动时间",
  "facts.mcp.calls": "MCP 调用次数",
  "facts.mcp.failed": "MCP 失败次数",
  "facts.changes.additions": "新增行数",
  "facts.changes.deletions": "删除行数",
  "facts.counts.reads": "读取次数",
  "facts.counts.searches": "搜索次数",
  "facts.counts.writes": "写入次数",
  "facts.counts.edits": "修改次数",
  "facts.processes.primary": "代理启动的进程",
  "facts.processes.runningAtEnd": "结束时仍在运行的进程",
  "facts.processes.tools": "辅助进程数",
  "facts.files.read": "读取的文件",
  "facts.files.created": "新建的文件",
  "facts.files.modified": "修改过的文件",
  "facts.files.deleted": "删除的文件",
  "facts.files.observed": "被外部改动的文件",
  "facts.files.byPath": "每一个碰过的文件",
  "facts.failed": "失败的命令列表",
  "facts.commandFacts": "每一条命令",
  "facts.knowledge.reads": "读过的文件",
  "facts.knowledge.searches": "做过的搜索",
  "facts.evidence": "这一轮的全部事件",
  "live.nowMs": "宿主传入的时钟",
  "live.stalledSeconds": "已停滞秒数",
  "live.elapsedSeconds": "已运行秒数",
  "live.busy": "代理是否在工作",
  "live.status": "代理状态",
  "live.metrics.eggs": "每个进程的资源快照",
};

/** Fallback for paths with no Chinese name: keep the catalogue's English label. */
export function fieldOptions(): Array<{ path: string; label: string; hint?: string; group?: string }> {
  return allFields().map((field) => ({
    path: field.path,
    label: ZH_FIELD[field.path] ?? field.label,
    hint: field.hint,
    group: field.group,
  }));
}

export function zhField(path: string): string {
  return ZH_FIELD[path] ?? fieldFor(path)?.label ?? path;
}

/* ── operators ───────────────────────────────────────────────────────────── */

const ZH_OP: Partial<Record<ScalarOp, string>> = {
  eq: "等于",
  ne: "不等于",
  gt: "大于",
  gte: "至少",
  lt: "小于",
  lte: "至多",
  between: "介于",
  in: "属于",
  notIn: "不属于",
  contains: "包含",
  notContains: "不包含",
  startsWith: "以…开头",
  notStartsWith: "不以…开头",
  endsWith: "以…结尾",
  notEndsWith: "不以…结尾",
  matches: "匹配正则",
  notMatches: "不匹配正则",
  glob: "匹配通配符",
  notGlob: "不匹配通配符",
  exists: "存在",
  notExists: "不存在",
  empty: "为空",
  nonEmpty: "不为空",
};

export function zhOp(op: ScalarOp | undefined): string {
  return (op && ZH_OP[op]) || String(op ?? "");
}

/* ── the one-sentence reading ────────────────────────────────────────────── */

function valueText(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

function conditionText(condition: Condition): string {
  if ("window" in condition) {
    const spec = condition.window;
    const types = Array.isArray(spec.events?.type)
      ? spec.events?.type.map(zhEventLabel).join("、")
      : spec.events?.type
        ? zhEventLabel(spec.events.type)
        : "事件";
    const span = spec.span?.lastMs
      ? `最近 ${Math.round(spec.span.lastMs / 1000)} 秒`
      : spec.span?.nextMs
        ? `接下来 ${Math.round(spec.span.nextMs / 1000)} 秒`
        : "整个运行过程";
    const measure: Record<string, string> = {
      count: "次数",
      streak: "连续次数",
      sum: "总和",
      max: "最大值",
      min: "最小值",
      avg: "平均值",
      gapMs: "间隔毫秒",
      distinct: "去重数",
    };
    const of = spec.of ? `(字段 ${spec.of})` : "";
    const where = spec.events?.where && spec.events.where.conditions.length > 0
      ? `，只算满足「${describeWhenZh(spec.events.where)}」的`
      : "";
    return `在${span}内，${types}${of} 的${measure[spec.measure] ?? spec.measure} ${zhOp(spec.op)} ${valueText(spec.value)}${where}`;
  }

  if ("quant" in condition) {
    if (condition.quant === "count") {
      return `${zhField(condition.field)} 的项数 ${zhOp(condition.op)} ${valueText(condition.value)}`;
    }
    const quant: Record<string, string> = {
      any: "至少有一项",
      all: "每一项都",
      none: "没有任何一项",
    };
    const where = condition.where && condition.where.conditions.length > 0
      ? `满足 ${describeWhenZh(condition.where)}`
      : "满足条件";
    return `${zhField(condition.field)} 中${quant[condition.quant] ?? condition.quant}${where}`;
  }

  if ("sequence" in condition) {
    const steps = condition.sequence.steps
      .map((step, index) => {
        const type = Array.isArray(step.type) ? step.type[0] : step.type;
        const label = type ? zhEventLabel(type) : "任意事件";
        return step.as ? `${index + 1}「${label}·${step.as}」` : `${index + 1}「${label}」`;
      })
      .join(" → ");
    const gap = condition.sequence.gap?.maxMs ? `（步间隔 ≤ ${Math.round(condition.sequence.gap.maxMs / 1000)} 秒）` : "";
    const times = condition.sequence.times && condition.sequence.times > 1 ? `，出现 ${condition.sequence.times} 次` : "";
    return `事件按顺序出现：${steps}${gap}${times}`;
  }

  const op = zhOp(condition.op);
  if (condition.op === "exists" || condition.op === "notExists" || condition.op === "empty" || condition.op === "nonEmpty") {
    return `${zhField(condition.field)} ${op}`;
  }
  return `${zhField(condition.field)} ${op} ${valueText(condition.value)}`;
}

export function describeWhenZh(when: When): string {
  const joiner = (when.combinator ?? "all") === "any" ? "，或 " : "，且 ";
  return when.conditions.map(conditionText).join(joiner) || "（无条件，永不触发）";
}

export function describeRuleZh(rule: Rule): string {
  const when = rule.when.conditions.length > 0 ? describeWhenZh(rule.when) : "";
  const level = rule.emit.level === "none" ? "规则关闭" : `发出「${zhLevel(rule.emit.level)}」提醒`;
  if (!when) return level;
  return `当 ${when} 时，${level}`;
}

/* ── rule templates ──────────────────────────────────────────────────────── */

export interface RuleTemplate {
  id: string;
  name: string;
  desc: string;
  icon: "pulse" | "flask" | "moon" | "clock" | "shield" | "blank";
  build: (id: string) => Rule;
}

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "failure-streak",
    name: "命令连续失败",
    desc: "代理反复碰壁还没爬出来 —— 最常见的失控信号",
    icon: "pulse",
    build: (id) => ({
      id,
      name: "命令连续失败",
      phase: "both",
      priority: 0,
      when: { combinator: "all", conditions: [{ field: "facts.failureStreak.count", op: "gte", value: 4 }] },
      emit: {
        level: "high",
        title: "连续 {{facts.failureStreak.count}} 条命令失败",
        tags: ["commands"],
        evidence: ["facts.failed"],
      },
    }),
  },
  {
    id: "unresolved",
    name: "错误没有恢复",
    desc: "出现过失败，并且之后再没有任何成功把它补救回来",
    icon: "flask",
    build: (id) => ({
      id,
      name: "错误没有恢复",
      phase: "settled",
      priority: 0,
      when: {
        combinator: "all",
        conditions: [
          { field: "facts.commands.failed", op: "gte", value: 1 },
          { field: "facts.unresolved", quant: "count", op: "gte", value: 1 },
        ],
      },
      emit: {
        level: "medium",
        title: "{{facts.unresolved.length}} 个失败没有得到恢复",
        tags: ["commands"],
        evidence: ["facts.unresolved"],
      },
    }),
  },
  {
    id: "stalled",
    name: "代理停住了",
    desc: "运行还在进行，但迟迟没有任何动静 —— 像心电图的平线",
    icon: "moon",
    build: (id) => ({
      id,
      name: "代理停住了",
      phase: "live",
      priority: 0,
      when: { combinator: "all", conditions: [{ field: "live.stalledSeconds", op: "gte", value: 120 }] },
      emit: {
        level: "high",
        title: "代理已经 {{live.stalledSeconds}} 秒没有任何活动",
        tags: ["live"],
        evidence: [],
      },
    }),
  },
  {
    id: "leftover",
    name: "进程没收尾",
    desc: "运行结束时还有进程挂在后台，占着资源",
    icon: "clock",
    build: (id) => ({
      id,
      name: "进程没收尾",
      phase: "settled",
      priority: 0,
      when: {
        combinator: "all",
        conditions: [{ field: "facts.processes.runningAtEnd", quant: "count", op: "gte", value: 1 }],
      },
      emit: {
        level: "low",
        title: "结束时仍有 {{facts.processes.runningAtEnd.length}} 个进程在运行",
        tags: ["processes"],
        evidence: ["facts.processes.runningAtEnd"],
      },
    }),
  },
  {
    id: "outside",
    name: "项目外的改动",
    desc: "有文件在项目目录之外被修改了 —— 值得看一眼",
    icon: "shield",
    build: (id) => ({
      id,
      name: "项目外的改动",
      phase: "both",
      priority: 0,
      when: {
        combinator: "all",
        conditions: [{ field: "facts.outsideChanges", quant: "count", op: "gte", value: 1 }],
      },
      emit: {
        level: "medium",
        title: "项目外有 {{facts.outsideChanges.length}} 处改动",
        tags: ["files"],
        evidence: ["facts.outsideChanges"],
      },
    }),
  },
  {
    id: "blank",
    name: "空白规则",
    desc: "从一条最简单的条件开始，自己搭",
    icon: "blank",
    build: (id) => ({
      id,
      name: "我的规则",
      phase: "both",
      priority: 0,
      when: { combinator: "all", conditions: [{ field: "facts.commands.failed", op: "gte", value: 3 }] },
      emit: {
        level: "medium",
        title: "失败命令达到 {{facts.commands.failed}} 条",
        tags: [],
        evidence: [],
      },
    }),
  },
];

/* ── runs, outcomes, timeline ────────────────────────────────────────────── */

const ZH_OUTCOME: Record<string, string> = {
  completed: "顺利完成",
  completed_with_warnings: "完成，但有警告",
  failed: "失败",
  stopped: "中途停止",
  no_change: "没有改动",
};

export function zhOutcome(outcome: string): string {
  return ZH_OUTCOME[outcome] ?? outcome;
}

const ZH_ACTION: Record<string, string> = {
  START: "启动",
  THINK: "思考",
  READ: "读取",
  SEARCH: "搜索",
  EDIT: "修改",
  WRITE: "写入",
  CREATE: "新建",
  OUTSIDE: "项目外",
  REMOVE: "删除",
  CHANGE: "变动",
  RUN: "执行",
  LAID: "启动进程",
  DIED: "进程退出",
  ERROR: "错误",
  END: "结束",
};

export function zhAction(action: string): string {
  return ZH_ACTION[action] ?? action;
}

/** The engine's one-line effect sentences, said in Chinese. */
export function zhEffect(effect: string): string {
  const read = /^lines (\d+)–(\d+) into context$/.exec(effect);
  if (read) return `读入第 ${read[1]}–${read[2]} 行`;
  const hits = /^(\d+) hits?(?: in (.+))?$/.exec(effect);
  if (hits) return `${hits[1]} 处命中${hits[2] ? ` · ${hits[2]}` : ""}`;
  const diff = /^changed \+(\d+) −(\d+) lines$/.exec(effect);
  if (diff) return `改动 +${diff[1]} −${diff[2]} 行`;
  const created = /^created (\d+) lines?$/.exec(effect);
  if (created) return `新建 ${created[1]} 行`;
  const rewrote = /^rewrote (\d+) lines$/.exec(effect);
  if (rewrote) return `重写 ${rewrote[1]} 行`;
  const exit = /^failed · exit (\d+)$/.exec(effect);
  if (exit) return `失败 · 退出码 ${exit[1]}`;
  const ok = /^exit (\d+)$/.exec(effect);
  if (ok) return `退出码 ${ok[1]}`;
  const pid = /^pid (\d+)(?: \+(\d+))?$/.exec(effect);
  if (pid) return `PID ${pid[1]}${pid[2] ? ` +${pid[2]} 个子进程` : ""}`;
  const exited = /^exited after (\d+)s$/.exec(effect);
  if (exited) return `${exited[1]} 秒后退出`;
  switch (effect) {
    case "changed outside the project":
      return "项目外发生了改动";
    case "deleted on disk":
      return "磁盘上被删除";
    case "the agent's write landed on disk":
      return "代理的写入已落盘";
    case "changed outside the agent":
      return "代理之外发生了改动";
    case "process still running":
      return "进程仍在运行";
    case "failed, no output captured":
      return "失败，没有输出";
    case "outcome unknown":
      return "结果未知";
    default:
      return effect;
  }
}

/* ── payload fields (the event form) ─────────────────────────────────────── */

const ZH_PAYLOAD: Record<string, string> = {
  model: "模型",
  reason: "原因",
  role: "角色",
  content: "内容",
  toolName: "工具",
  args: "参数",
  partial: "部分输出",
  isError: "出错",
  path: "路径",
  startLine: "起始行",
  endLine: "结束行",
  before: "改动前",
  after: "改动后",
  diff: "差异",
  kind: "种类",
  outside: "项目外",
  command: "命令",
  stdout: "标准输出",
  stderr: "错误输出",
  exitCode: "退出码",
  tool: "工具",
  query: "查询",
  scope: "范围",
  matches: "命中数",
  name: "名称",
  commandLine: "命令行",
  status: "状态",
  children: "子进程数",
  server: "服务",
  message: "消息",
  id: "事件 ID",
  type: "事件类型",
  timestamp: "发生时间",
  title: "标题",
  detail: "说明",
  options: "选项",
  pid: "PID",
  ppid: "父进程",
  startedAt: "启动时间",
  exitedAt: "退出时间",
  toolCallId: "调用 ID",
  durationMs: "耗时(毫秒)",
};

export function zhPayload(path: string): string {
  const leaf = path.split(".").pop() ?? path;
  return ZH_PAYLOAD[leaf] ?? leaf;
}

/* ── window measures, quantifiers, combinator ────────────────────────────── */

const ZH_MEASURE: Record<string, string> = {
  count: "次数",
  streak: "连续次数",
  sum: "总和",
  max: "最大值",
  min: "最小值",
  avg: "平均值",
  gapMs: "间隔(毫秒)",
  distinct: "去重数",
};

export function zhMeasure(measure: string): string {
  return ZH_MEASURE[measure] ?? measure;
}

const ZH_QUANT: Record<string, string> = {
  any: "其中任一项",
  all: "每一项都",
  none: "没有任何一项",
  count: "项数",
};

export function zhQuant(quant: string): string {
  return ZH_QUANT[quant] ?? quant;
}

/* ── field groups, for a picker that is readable at a glance ─────────────── */

export function fieldGroup(path: string): string {
  if (path.startsWith("live.")) return "实时状态";
  if (path.startsWith("facts.commands") || path === "facts.failed" || path === "facts.commandFacts") return "命令";
  if (path.startsWith("facts.files") || path.startsWith("facts.changes") || path.startsWith("facts.counts")) return "文件";
  if (path.startsWith("facts.processes")) return "进程";
  if (path.startsWith("facts.mcp")) return "MCP";
  if (path.startsWith("facts.run") || path === "facts.ended" || path === "facts.currentPhase" || path === "facts.lastActivityAt") {
    return "运行";
  }
  if (path.startsWith("facts.knowledge") || path === "facts.response") return "阅读与输出";
  return "异常";
}

/* ── evidence: what a finding may point at ───────────────────────────────── */

export interface EvidenceChoice {
  path: string;
  label: string;
  hint?: string;
}

export const EVIDENCE_CHOICES: EvidenceChoice[] = [
  { path: "facts.failed", label: "失败的命令", hint: "每条失败命令的事件 id" },
  { path: "facts.unresolved", label: "未恢复的失败", hint: "没有任何成功或修改补救过的失败" },
  { path: "facts.failureStreak.evidence", label: "连续失败的事件", hint: "最长连败那一段的事件 id" },
  { path: "facts.errors.evidence", label: "错误事件", hint: "error 事件的事件 id" },
  { path: "facts.processes.runningAtEnd", label: "未收尾的进程", hint: "结束时仍在运行的进程" },
  { path: "facts.outsideChanges", label: "项目外的改动", hint: "项目目录之外被改动的文件" },
  { path: "facts.reverts", label: "被改回去的文件", hint: "内容回到之前版本的文件" },
  { path: "facts.retries", label: "反复失败的命令", hint: "同一条命令失败多次" },
  { path: "facts.files.created", label: "新建的文件", hint: "这一轮新建的路径" },
  { path: "facts.files.modified", label: "修改过的文件", hint: "这一轮改动的路径" },
  { path: "facts.files.deleted", label: "删除的文件", hint: "这一轮删掉的路径" },
  { path: "window.ids", label: "窗口选中的事件", hint: "时间窗口条件筛出来的事件" },
  { path: "facts.evidence", label: "这一轮的全部事件", hint: "运行里的每一个事件 id" },
];

export function zhEvidence(path: string): string {
  return EVIDENCE_CHOICES.find((choice) => choice.path === path)?.label ?? path;
}

/* ── quick conditions: a rule without training ────────────────────────────── */

export interface ConditionPreset {
  id: string;
  label: string;
  hint: string;
  build: () => Condition;
}

export const CONDITION_PRESETS: ConditionPreset[] = [
  {
    id: "failed-count",
    label: "命令失败数达到…",
    hint: "这一轮里失败的命令数量",
    build: () => ({ field: "facts.commands.failed", op: "gte", value: 3 }),
  },
  {
    id: "streak",
    label: "连续失败达到…",
    hint: "中间没有一次成功的连败",
    build: () => ({ field: "facts.failureStreak.count", op: "gte", value: 3 }),
  },
  {
    id: "window-failures",
    label: "最近 2 分钟内失败…次",
    hint: "只看锚点往前两分钟，时间窗口条件",
    build: () => ({
      window: {
        events: {
          type: ["command"],
          where: { conditions: [{ field: "payload.exitCode", op: "ne", value: 0 }] },
        },
        span: { lastMs: 120_000 },
        measure: "count",
        op: "gte",
        value: 3,
      },
    }),
  },
  {
    id: "unresolved",
    label: "有未恢复的失败",
    hint: "失败之后既没有成功命令，也没有修改",
    build: () => ({ field: "facts.unresolved", quant: "count", op: "gte", value: 1 }),
  },
  {
    id: "processes",
    label: "有进程没退出",
    hint: "运行结束时还挂在后台的进程",
    build: () => ({ field: "facts.processes.runningAtEnd", quant: "count", op: "gte", value: 1 }),
  },
  {
    id: "outside",
    label: "项目外有改动",
    hint: "项目目录之外的文件被改动了",
    build: () => ({ field: "facts.outsideChanges", quant: "count", op: "gte", value: 1 }),
  },
  {
    id: "reverts",
    label: "文件被反复改回",
    hint: "同一份内容来回改，代理可能绕圈",
    build: () => ({ field: "facts.reverts", quant: "count", op: "gte", value: 1 }),
  },
  {
    id: "elapsed",
    label: "运行超过…分钟",
    hint: "运行时长，进行中阶段可读",
    build: () => ({ field: "live.elapsedSeconds", op: "gte", value: 600 }),
  },
  {
    id: "stalled",
    label: "停滞超过…秒",
    hint: "运行还在进行，但一直没有动静",
    build: () => ({ field: "live.stalledSeconds", op: "gte", value: 120 }),
  },
  {
    id: "error-event",
    label: "出现错误事件",
    hint: "error 事件，通常比失败命令更弱",
    build: () => ({ field: "facts.errors.total", op: "gt", value: 0 }),
  },
];

/* ── template variables, for the "insert data" menu ──────────────────────── */

export interface TemplateVar {
  /** The expression inside the braces, filters included: `facts.failed|count`. */
  expr: string;
  label: string;
}

export const TEMPLATE_VARS: TemplateVar[] = [
  { expr: "facts.commands.failed", label: "失败命令数" },
  { expr: "facts.commands.total", label: "命令总数" },
  { expr: "facts.failureStreak.count", label: "最长连败" },
  { expr: "facts.unresolved|count", label: "未恢复的失败数" },
  { expr: "facts.errors.total", label: "错误事件数" },
  { expr: "facts.files.created|count", label: "新建文件数" },
  { expr: "facts.files.modified|count", label: "修改文件数" },
  { expr: "facts.processes.runningAtEnd|count", label: "未收尾进程数" },
  { expr: "facts.outsideChanges|count", label: "项目外改动数" },
  { expr: "facts.run.id", label: "运行 id" },
  { expr: "facts.run.status", label: "运行状态" },
  { expr: "live.elapsedSeconds", label: "已运行秒数" },
  { expr: "live.stalledSeconds", label: "停滞秒数" },
];

/* ── enumerated values: a select instead of a free-text box ──────────────── */

const ZH_VALUE: Record<string, string> = {
  running: "进行中",
  completed: "已完成",
  error: "出错",
  interrupted: "被中断",
  aborted: "被中断",
  investigating: "调查中",
  implementing: "实现中",
  executing: "执行中",
  verifying: "验证中",
  recovering: "恢复中",
  user: "用户",
  assistant: "助手",
  system: "系统",
  exited: "已退出",
  created: "新建",
  modified: "修改",
  deleted: "删除",
  success: "成功",
  failed: "失败",
  unknown: "未知",
  primary: "代理启动",
  tool: "辅助",
};

export function zhEnum(value: string): string {
  return ZH_VALUE[value] ?? value;
}

const ENUM_FIELDS: Record<string, string[]> = {
  "facts.run.status": ["running", "completed", "error", "interrupted"],
  "facts.currentPhase": ["investigating", "implementing", "executing", "verifying", "recovering"],
  "payload.role": ["user", "assistant", "system"],
  "payload.status": ["running", "exited"],
  "payload.reason": ["completed", "aborted", "error"],
};

/** The known values of an enumerated field, so the editor can offer a select. */
export function valueChoices(path: string): Array<{ value: string; label: string }> | undefined {
  const values = ENUM_FIELDS[path];
  if (!values) return undefined;
  return values.map((value) => ({ value, label: `${zhEnum(value)} (${value})` }));
}
