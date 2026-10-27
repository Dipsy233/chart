/**
 * The run report, rendered as a document.
 *
 * `RenderedReport` is a document model, so this file is a renderer and nothing
 * else — no judging, no formatting decisions the engine already made. The
 * typography is the point: sans for prose, mono for identifiers, generous line
 * height, and section rules that read like a report rather than a log dump.
 *
 * The engine's own sentences (outcome headlines, timeline effects, command
 * statuses) are English by design; this renderer says them in Chinese. A custom
 * spec can still use the English titles — `ZH_SECTION` maps the ones the engine
 * ships with.
 */

import type { RenderedReport, RenderedSection } from "../../../src/report/spec.ts";
import { zhAction, zhEffect, zhEnum, zhLevel, zhOutcome } from "../lib/plain.ts";

/** The engine's English section titles, in the ward's language. */
const ZH_SECTION: Record<string, string> = {
  "at a glance": "一览",
  findings: "触发结果",
  "unresolved failures": "未恢复的失败",
  commands: "命令",
  files: "文件",
  processes: "进程",
  "world line": "事件时间线",
  evidence: "证据事件",
  "what the agent learned": "读过的东西",
};

function zhSection(title: string | undefined): string {
  if (!title) return "";
  return ZH_SECTION[title.toLowerCase()] ?? title;
}

const ZH_CELL: Record<string, string> = {
  success: "成功",
  failed: "失败",
  running: "运行中",
  unknown: "未知",
  created: "新建",
  modified: "修改",
  deleted: "删除",
  read: "读",
  write: "写",
  edit: "改",
  external: "外部",
  completed: "已完成",
  aborted: "被中断",
  error: "出错",
};

function zhCell(cell: string): string {
  return ZH_CELL[cell] ?? cell;
}

export function ReportDocument({ report }: { report: RenderedReport }) {
  const header = report.sections.find((section) => section.kind === "header");
  const rest = report.sections.filter((section) => section.kind !== "header");

  return (
    <div className="report">
      <div className="report-head">
        <h1>{header?.kind === "header" ? header.title : report.title}</h1>
        {header?.kind === "header" && header.subtitle ? <div className="sub">{header.subtitle}</div> : null}
      </div>
      {rest.map((section, index) => (
        <Section key={index} section={section} />
      ))}
    </div>
  );
}

function Section({ section }: { section: RenderedSection }) {
  switch (section.kind) {
    case "header":
      return null;

    case "verdict":
      return (
        <section>
          <div className="verdict">
            <span className={`level ${section.level}`}>{zhLevel(section.level)}</span>
            <span className="outcome">{zhOutcome(section.outcome)}</span>
          </div>
          {section.findings.length > 0 ? (
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              {section.findings.map((finding, index) => (
                <div className={`finding ${finding.level}`} key={index}>
                  <div className="title">{finding.title}</div>
                  {finding.detail ? <div className="detail">{finding.detail}</div> : null}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      );

    case "findings":
      return (
        <section>
          <h2>{zhSection(section.title)}</h2>
          {section.findings.length === 0 ? (
            <div className="empty">{section.empty ?? "没有。"}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {section.findings.map((finding, index) => (
                <div className={`finding ${finding.level}`} key={index}>
                  <div className="title">
                    <span className={`chip ${finding.level}`}>{zhLevel(finding.level)}</span> {finding.title}
                  </div>
                  {finding.detail ? <div className="detail">{finding.detail}</div> : null}
                  {finding.evidence.length > 0 ? (
                    <div className="ev">
                      证据事件 {finding.evidence.length} 条：{finding.evidence.slice(0, 6).join(" · ")}
                      {finding.evidence.length > 6 ? "…" : ""}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      );

    case "stats":
      return (
        <section>
          <h2>{zhSection(section.title ?? "At a glance")}</h2>
          <div className="stats">
            {section.rows.map((row, index) => (
              <div key={index}>
                <span className="k">{row.label}</span>
                <span className="v">{row.value || "—"}</span>
              </div>
            ))}
          </div>
        </section>
      );

    case "table":
      return (
        <section>
          <h2>{zhSection(section.title ?? "Table")}</h2>
          {section.rows.length === 0 ? (
            <div className="empty">{section.empty ?? "没有。"}</div>
          ) : (
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    {section.columns.map((column, index) => (
                      <th key={index}>{column.header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className={cellIndex === 0 ? "mono" : undefined}>
                          {zhCell(cell) || "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      );

    case "list":
      return (
        <section>
          <h2>{zhSection(section.title ?? "List")}</h2>
          {section.items.length === 0 ? (
            <div className="empty">{section.empty ?? "没有。"}</div>
          ) : (
            <ul>
              {section.items.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          )}
        </section>
      );

    case "timeline":
      return (
        <section>
          <h2>{zhSection(section.title ?? "World line")}</h2>
          {section.nodes.length === 0 ? (
            <div className="empty">{section.empty ?? "没有。"}</div>
          ) : (
            <div className="timeline">
              {section.nodes.map((node, index) => (
                <div className="tl-row" key={index}>
                  <span className="t">{(node.offsetMs / 1000).toFixed(0)}s</span>
                  <span className="act">{zhAction(node.action)}</span>
                  <span className="subject">{node.action === "END" ? zhEnum(node.subject) : node.subject}</span>
                  <span className="effects">{node.effects.map(zhEffect).join(" · ")}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      );

    case "evidence":
      return (
        <section>
          <h2>{zhSection(section.title ?? "Evidence")}</h2>
          <div className="tiny muted mono">
            记录里有 {section.ids.length} 个事件 — {section.ids.slice(0, 8).join(", ")}
            {section.ids.length > 8 ? "…" : ""}
          </div>
        </section>
      );
  }
}
