/**
 * The run report, rendered as a document.
 *
 * `RenderedReport` is a document model, so this file is a renderer and nothing
 * else — no judging, no formatting decisions the engine already made. The typography
 * is the point: sans for prose, mono for identifiers, generous line height, and
 * section rules that read like a report rather than a log dump.
 */

import type { RenderedReport, RenderedSection } from "../../../src/report/spec.ts";

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
            <span className={`level ${section.level}`}>{section.level}</span>
            <span className="muted">{section.outcome.replace(/_/g, " ")}</span>
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
          <h2>{section.title}</h2>
          {section.findings.length === 0 ? (
            <div className="empty">{section.empty ?? "nothing"}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {section.findings.map((finding, index) => (
                <div className={`finding ${finding.level}`} key={index}>
                  <div className="title">{finding.title}</div>
                  {finding.detail ? <div className="detail">{finding.detail}</div> : null}
                  <div className="ev">{finding.evidence.slice(0, 6).join(" · ")}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      );

    case "stats":
      return (
        <section>
          <h2>{section.title ?? "At a glance"}</h2>
          <div className="stats">
            {section.rows.map((row, index) => (
              <div key={index}>
                <span className="k">{row.label}</span>
                <span className="v">{row.value}</span>
              </div>
            ))}
          </div>
        </section>
      );

    case "table":
      return (
        <section>
          <h2>{section.title ?? "Table"}</h2>
          {section.rows.length === 0 ? (
            <div className="empty">{section.empty ?? "nothing"}</div>
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
                          {cell || "—"}
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
          <h2>{section.title ?? "List"}</h2>
          {section.items.length === 0 ? (
            <div className="empty">{section.empty ?? "nothing"}</div>
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
          <h2>{section.title ?? "World line"}</h2>
          {section.nodes.length === 0 ? (
            <div className="empty">{section.empty ?? "nothing"}</div>
          ) : (
            <div className="timeline">
              {section.nodes.map((node, index) => (
                <div key={index} style={{ display: "flex", gap: 14, padding: "3px 0" }}>
                  <span className="t" style={{ width: 56, textAlign: "right" }}>
                    {(node.offsetMs / 1000).toFixed(0)}s
                  </span>
                  <span className="act" style={{ width: 78 }}>
                    {node.action}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>{node.subject}</span>
                  <span style={{ color: "var(--dim)", flex: "0 1 40%" }}>{node.effects.join(" · ")}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      );

    case "evidence":
      return (
        <section>
          <h2>{section.title ?? "Evidence"}</h2>
          <div className="tiny muted">
            {section.ids.length} events in the record — {section.ids.slice(0, 8).join(", ")}
            {section.ids.length > 8 ? "…" : ""}
          </div>
        </section>
      );
  }
}
