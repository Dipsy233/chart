/**
 * The report spec the editor shows.
 *
 * Specs are data, and the engine ships English ones so the CLI demo and the
 * tests can be read by anyone. The ward speaks Chinese, so the editor brings its
 * own spec — the same sections, the same sources, Chinese titles. Nothing here
 * judges anything: `renderReport` turns this plus an observation into a document.
 *
 * One spec covers both playback and the settled run: `live.elapsedSeconds` is
 * derived from the anchor, so the same document reads correctly at every frame.
 */

import type { ReportSpec } from "../../../src/report/spec.ts";

export const ZH_REPORT: ReportSpec = {
  id: "ward",
  title: "运行报告",
  description: "这一轮做了什么、留下了什么、有什么值得看一眼。",
  for: "any",
  sections: [
    {
      kind: "header",
      title: "运行报告 · {{facts.run.id}}",
      subtitle:
        "{{facts.commands.total}} 条命令 · {{facts.files.created|count}} 个新文件 · {{facts.files.modified|count}} 个修改",
    },
    { kind: "verdict", showFindings: false },
    {
      kind: "findings",
      title: "触发结果",
      minLevel: "low",
      limit: 30,
      empty: "这一轮没有任何规则触发。",
    },
    {
      kind: "stats",
      title: "一览",
      rows: [
        { label: "已运行", value: "{{live.elapsedSeconds|secs}}" },
        { label: "命令", value: "{{facts.commands.succeeded}} 成功 / {{facts.commands.failed}} 失败" },
        {
          label: "文件",
          value:
            "{{facts.files.created|count}} 新建 · {{facts.files.modified|count}} 修改 · {{facts.files.deleted|count}} 删除",
        },
        { label: "代码行", value: "+{{facts.changes.additions}} −{{facts.changes.deletions}}" },
        { label: "进程", value: "{{facts.processes.primary|count}} 启动 · {{facts.processes.runningAtEnd|count}} 未收尾" },
        { label: "读取", value: "{{facts.counts.reads}} 次 · 搜索 {{facts.counts.searches}} 次" },
        { label: "MCP", value: "{{facts.mcp.calls}} 次 · {{facts.mcp.failed}} 次失败" },
        { label: "错误事件", value: "{{facts.errors.total}}" },
      ],
    },
    {
      kind: "table",
      title: "命令",
      source: "facts.commandFacts",
      columns: [
        { header: "命令", cell: "{{vars.row.command}}", width: "wide" },
        { header: "结果", cell: "{{vars.row.status}}", width: "narrow" },
        { header: "退出码", cell: "{{vars.row.exitCode}}", width: "narrow" },
        { header: "耗时", cell: "{{vars.row.durationMs|duration}}", width: "narrow" },
      ],
      limit: 60,
      empty: "这一轮没有执行命令。",
    },
    {
      kind: "table",
      title: "文件",
      source: "facts.files.byPath",
      columns: [
        { header: "路径", cell: "{{vars.row.path}}", width: "wide" },
        {
          header: "方式",
          cell: "{{vars.row.agentWrite|flag:写}}{{vars.row.agentEdit|flag:改}}{{vars.row.externalChange|flag:外部}}{{vars.row.read|flag:读}}",
          width: "narrow",
        },
        { header: "+/−", cell: "+{{vars.row.additions}} −{{vars.row.deletions}}", width: "narrow" },
      ],
      limit: 80,
      empty: "这一轮没有碰任何文件。",
    },
    {
      kind: "table",
      title: "进程",
      source: "facts.processes.primary",
      columns: [
        { header: "名称", cell: "{{vars.row.name}}", width: "narrow" },
        { header: "PID", cell: "{{vars.row.pid}}", width: "narrow" },
        { header: "存活", cell: "{{vars.row.lifetimeMs|duration}}", width: "narrow" },
        { header: "状态", cell: "{{vars.row.running|bool:运行中，已退出}}", width: "narrow" },
      ],
      limit: 40,
      empty: "这一轮没有启动进程。",
    },
    {
      kind: "table",
      title: "读过的东西",
      source: "facts.knowledge.reads",
      columns: [
        { header: "路径", cell: "{{vars.row.path}}", width: "wide" },
        { header: "行", cell: "{{vars.row.startLine}}–{{vars.row.endLine}}", width: "narrow" },
      ],
      limit: 40,
      empty: "这一轮没有读取文件。",
    },
    { kind: "timeline", title: "事件时间线", limit: 60, empty: "什么都没有发生。" },
    { kind: "evidence", title: "证据事件", limit: 200 },
  ],
};
