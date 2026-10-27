/**
 * The default pack — Chart's judgement of a run, before anyone edits anything.
 *
 * This is Absence v0.4's `computeAttention`, expressed as data instead of
 * branches. Same reasons, same levels, same thresholds, same exclusivity, so
 * swapping the engine in changes no verdict. Every number here is what the
 * settings dialog used to expose; now it is a line in a rule the user can edit.
 *
 * Two things to read carefully:
 *
 *   1. **Exclusivity is written into the conditions.** The old code was an
 *      `else if` chain: an unresolved failure at rest outranks the plain failure
 *      count, and the "bare error event" branch is only reachable when neither
 *      fired. Rules run in parallel here, so each rule carries the negation that
 *      made it exclusive in the chain — read `run.commands-failed`.
 *
 *   2. **The live/settled split is a condition, not a field.** A leftover process
 *      is only meaningful once the run has settled; a stall is only meaningful
 *      while it is live. The old engine got that from which branch read which
 *      input; this engine made it a `phase` field; now it is a `facts.ended`
 *      condition, which is the one thing the rule already had to mean.
 */

import type { Rule, RulePack } from "./rule.ts";

/** `not needsYou` — still running, and not waiting on the user. */
const stillWorking = (): Rule["when"]["conditions"] => [
  { field: "facts.ended", op: "eq", value: false },
  { field: "live.busy", op: "ne", value: false },
];

export const DEFAULT_PACK: RulePack = {
  version: 1,
  name: "内置默认规则",
  rules: [
    {
      id: "run.agent-stopped",
      name: "代理带着错误停止",
      description: "这一轮没有跑完，以错误状态结束。",
      source: "default",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: true },
          { field: "facts.run.status", op: "eq", value: "error" },
        ],
      },
      emit: {
        reason: "agent_stopped",
        level: "high",
        title: "代理带着错误停止了",
        detail: "直接崩掉的运行从来不是小事：看最后一条命令和代理的回复。",
        tags: ["run", "failure"],
      },
    },
    {
      id: "run.unresolved-error",
      name: "未恢复的失败(已结束)",
      description: "运行结束后，仍有失败没有任何成功命令或修改把它补救回来。",
      source: "default",
      priority: 10,
      when: {
        conditions: [
          { field: "facts.unresolved", op: "nonEmpty" },
          { field: "facts.ended", op: "eq", value: true },
        ],
      },
      emit: {
        reason: "unresolved_error",
        level: "high",
        title: "{{facts.unresolved|count}} 个失败没有得到恢复",
        detail: "失败之后既没有成功的命令，也没有任何文件被修改。",
        tags: ["failure"],
        evidence: ["facts.unresolved"],
      },
    },
    {
      id: "run.unresolved-error-while-waiting",
      name: "未恢复的失败(等待用户)",
      description: "同样的判断，用于运行还在进行、但代理已经停下来等用户的时刻。",
      source: "default",
      priority: 10,
      when: {
        conditions: [
          { field: "facts.unresolved", op: "nonEmpty" },
          { field: "facts.ended", op: "eq", value: false },
          { field: "live.busy", op: "eq", value: false },
        ],
      },
      emit: {
        reason: "unresolved_error",
        level: "high",
        title: "{{facts.unresolved|count}} 个失败没有得到恢复",
        detail: "失败之后既没有成功的命令，也没有任何文件被修改。",
        tags: ["failure"],
        evidence: ["facts.unresolved"],
      },
    },
    {
      id: "run.commands-failed-recovered",
      name: "失败命令(全部已恢复)",
      description: "失败达到 5 次以上，但每一次之后都有成功命令或修改把它补了回来。",
      source: "default",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: true },
          { field: "facts.unresolved", op: "empty" },
          { field: "facts.commands.failed", op: "gte", value: 5 },
        ],
      },
      emit: {
        reason: "command_failed",
        level: "low",
        title: "这一轮有 {{facts.commands.failed}} 条命令失败",
        tags: ["commands"],
        evidence: ["facts.failed"],
      },
    },
    {
      id: "run.commands-failed-midrun",
      name: "失败命令超过阈值(进行中)",
      description: "计数规则的进行中版本：代理还在干活，失败数已经超过阈值。",
      source: "default",
      when: {
        conditions: [
          { field: "facts.unresolved", op: "nonEmpty" },
          ...stillWorking(),
          { field: "facts.commands.failed", op: "gte", value: 5 },
        ],
      },
      emit: {
        reason: "command_failed",
        level: "low",
        title: "到目前为止已有 {{facts.commands.failed}} 条命令失败",
        tags: ["commands"],
        evidence: ["facts.failed"],
      },
    },
    {
      id: "run.error-event",
      name: "孤立的错误事件",
      description: "出现了 error 事件，但背后没有失败命令 —— 较弱的信号，默认只给「警告」。",
      source: "default",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: true },
          { field: "facts.unresolved", op: "empty" },
          { field: "facts.commands.failed", op: "lt", value: 5 },
          { field: "facts.errors.total", op: "gt", value: 0 },
        ],
      },
      emit: {
        reason: "unresolved_error",
        level: "medium",
        title: "{{facts.errors.total}} 个错误事件，背后没有失败命令",
        detail: "上限是「警告」:孤立的 error 事件比失败命令弱一档。",
        tags: ["failure"],
        evidence: ["facts.errors.evidence"],
      },
    },
    {
      id: "run.failure-streak",
      name: "命令连续失败",
      description: "连续三条命令失败，中间没有一次成功：代理可能在反复碰壁。进行中和结束后都判读。",
      source: "default",
      when: {
        conditions: [{ field: "facts.failureStreak.count", op: "gte", value: 3 }],
      },
      emit: {
        reason: "command_failure_streak",
        level: "medium",
        title: "连续 {{facts.failureStreak.count}} 条命令失败",
        tags: ["commands", "loop"],
        evidence: ["facts.failureStreak.evidence"],
      },
    },
    {
      id: "run.stalled",
      name: "长时间没有动静",
      description: "运行还在进行，但 3600 秒内什么都没有发生：命令卡死，或者提示词卡住了。只在进行中判读。",
      source: "default",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: false },
          { field: "live.stalledSeconds", op: "gte", value: 3600 },
        ],
      },
      emit: {
        reason: "activity_stalled",
        level: "medium",
        title: "已经 {{live.stalledSeconds|secs}} 没有任何活动",
        detail: "运行仍在进行，但很久没有任何事件。",
        tags: ["run", "stall"],
      },
    },
    {
      id: "run.leftover-eggs",
      name: "有进程没收尾",
      description: "代理启动的进程在运行结束后仍然活着。Chart 会报告每一个;想跳过辅助进程，可以在条件里加 lifetimeMs 或名称过滤。",
      source: "default",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: true },
          { field: "facts.processes.runningAtEnd", quant: "count", op: "gte", value: 1 },
        ],
      },
      emit: {
        reason: "process_left_running",
        level: "high",
        title: "运行结束后仍有 {{facts.processes.runningAtEnd|count}} 个进程在运行",
        detail: "代理启动的东西还活着，而且没人看着。",
        tags: ["process"],
        evidence: ["facts.processes.runningAtEnd"],
      },
    },
    {
      id: "run.outside-change",
      name: "项目外的改动",
      description: "监视器发现项目目录之外有改动 —— 少见、与代理无关、通常能解释清楚。要忽略某些路径，把条件收窄即可。",
      source: "default",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: true },
          { field: "facts.outsideChanges", quant: "count", op: "gte", value: 1 },
        ],
      },
      emit: {
        reason: "outside_change",
        level: "low",
        title: "项目外有 {{facts.outsideChanges|count}} 处改动",
        tags: ["files", "outside"],
        evidence: ["facts.outsideChanges"],
      },
    },
    {
      id: "run.file-version-loop",
      name: "文件被改回旧版本",
      description: "代理把一个文件写回了它已经持有过的状态：它推翻了自己的工作。",
      source: "default",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: true },
          { field: "facts.reverts", quant: "count", op: "gte", value: 1 },
        ],
      },
      emit: {
        reason: "file_version_loop",
        level: "medium",
        title: "{{facts.reverts|count}} 个文件被改回旧版本",
        detail: "「改回」意味着代理改了文件又改回去，或者写入了和开始时一样的内容。",
        tags: ["files", "loop"],
        evidence: ["facts.reverts"],
      },
    },
    {
      id: "run.command-retry-loop",
      name: "同一条命令反复失败",
      description: "同一条命令失败了两次以上：代理是卡住了，不是运气不好。进行中和结束后都判读。",
      source: "default",
      when: {
        conditions: [
          {
            field: "facts.retries",
            quant: "count",
            op: "gte",
            value: 1,
            where: { conditions: [{ field: "count", op: "gte", value: 2 }] },
          },
        ],
      },
      emit: {
        reason: "command_retry_loop",
        level: "medium",
        title: "{{facts.retries|count}} 条命令反复失败",
        tags: ["commands", "loop"],
        evidence: ["facts.retries"],
      },
    },
  ],
};

/** A fresh copy, so a caller can mutate its own pack without touching this one. */
export function defaultPack(): RulePack {
  return structuredClone(DEFAULT_PACK);
}
