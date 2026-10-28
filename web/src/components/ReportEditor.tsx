/**
 * 报告编辑 — the report, as data you can edit.
 *
 * This is the half the user was missing: rules were customisable and reports were
 * not. A report is a `ReportSpec` (see `docs/REPORTS.md`), so editing one is
 * editing a list of sections — the same shape as editing a list of rules, and
 * deliberately built the same way:
 *
 *   sections ─┬─ header      a title block
 *             ├─ verdict     the level and the outcome
 *             ├─ findings    what the rules said
 *             ├─ stats       label/value rows
 *             ├─ table       rows from an array, with a filter
 *             ├─ list        one line per element
 *             ├─ text        a paragraph (the reply, the prompt, a transcript)
 *             ├─ timeline    the run's world line
 *             └─ evidence    the audit trail
 *
 * Two rules this panel keeps, because they are what keep a report honest:
 *
 *   1. **A report never judges.** Every section reads facts or findings that
 *      already exist; there is no way to express a threshold here. A user who
 *      wants "only the failures" writes a rule, and the report shows it.
 *   2. **The preview is the answer.** A spec whose `source` is a typo renders
 *      "nothing to show" forever, so the preview runs the real renderer against
 *      the selected run and shows the document it produced — with the template
 *      paths that did not resolve called out.
 */

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { ChartEvent } from "../../../src/core/events.ts";
import { observeRun, renderReport, validateSpec, checkTemplate } from "../../../src/index.ts";
import { deriveRuns } from "../../../src/facts/runs.ts";
import type { Run } from "../../../src/core/types.ts";
import type { ReportSection, ReportSpec, SectionFilter } from "../../../src/report/spec.ts";
import type { RulePack } from "../../../src/regimen/rule.ts";
import { ReportDocument } from "./ReportDocument.tsx";
import { useDragSort } from "./useDragSort.ts";

const KIND_LABEL: Record<ReportSection["kind"], { label: string; hint: string }> = {
  header: { label: "标题", hint: "报告最上面的标题和副标题" },
  verdict: { label: "结论", hint: "提醒级别和这一轮的结果" },
  findings: { label: "触发结果", hint: "规则说了什么，最响的在前" },
  stats: { label: "一览", hint: "几行「标签：数值」" },
  table: { label: "表格", hint: "从一组数据里取若干列" },
  list: { label: "列表", hint: "一条一行，比如文件清单" },
  text: { label: "段落", hint: "一段话：代理的回复、开场提问、思考" },
  timeline: { label: "时间线", hint: "这一轮按顺序发生的事" },
  evidence: { label: "证据", hint: "用于核对的事件 id" },
};

/** Which section kinds can hold a `filter`. */
const FILTERABLE = new Set<ReportSection["kind"]>(["table", "list", "text", "findings"]);

/** What a new section starts as — valid, and obviously a placeholder. */
function blankSection(kind: ReportSection["kind"]): ReportSection {
  switch (kind) {
    case "header":
      return { kind: "header", title: "{{facts.run.id}}", subtitle: "{{vars.headline}}" };
    case "verdict":
      return { kind: "verdict" };
    case "findings":
      return { kind: "findings", title: "触发结果", minLevel: "low", limit: 30, empty: "没有规则触发。" };
    case "stats":
      return { kind: "stats", title: "一览", rows: [{ label: "命令", value: "{{facts.commands.total}}" }] };
    case "table":
      return {
        kind: "table",
        title: "命令",
        source: "facts.commandFacts",
        columns: [
          { header: "命令", cell: "{{vars.row.command}}", width: "wide" },
          { header: "结果", cell: "{{vars.row.status}}", width: "narrow" },
        ],
        limit: 40,
        empty: "没有命令。",
      };
    case "list":
      return {
        kind: "list",
        title: "新建的文件",
        source: "facts.files.created",
        item: "{{vars.row}}",
        limit: 40,
        empty: "没有新建文件。",
      };
    case "text":
      return { kind: "text", title: "代理的回复", source: "facts.response", empty: "没有回复。" };
    case "timeline":
      return { kind: "timeline", title: "时间线", limit: 40 };
    case "evidence":
      return { kind: "evidence", title: "证据", limit: 200 };
  }
}

export function ReportEditor({
  spec,
  events,
  runId,
  pack,
  readOnly,
  onChange,
  onOpenReport,
  onNotify,
}: {
  spec: ReportSpec;
  events: ChartEvent[];
  runId?: string;
  pack: RulePack;
  readOnly?: boolean;
  onChange: (spec: ReportSpec) => void;
  onOpenReport: () => void;
  onNotify?: (text: string, tone?: "info" | "error") => void;
}) {
  const [selected, setSelected] = useState(0);
  const [showKinds, setShowKinds] = useState(false);
  const issues = useMemo(() => validateSpec(spec), [spec]);

  // No `readOnly` guard here: a built-in spec is read-only as a *file*, not as a
  // document. An edit is passed up, and the host forks it into a named copy —
  // exactly what happens when you edit a built-in rule pack. Blocking the edit
  // here would mean the user's change is simply thrown away.
  const patch = (next: ReportSpec) => {
    onChange(next);
  };

  const updateSection = (index: number, section: ReportSection) => {
    const sections = [...spec.sections];
    sections[index] = section;
    patch({ ...spec, sections });
  };
  const removeSection = (index: number) => {
    patch({ ...spec, sections: spec.sections.filter((_, i) => i !== index) });
    setSelected(Math.max(0, Math.min(index, spec.sections.length - 2)));
  };
  const addSection = (kind: ReportSection["kind"]) => {
    patch({ ...spec, sections: [...spec.sections, blankSection(kind)] });
    setSelected(spec.sections.length);
    setShowKinds(false);
  };
  const moveSection = (from: number, to: number) => {
    const sections = [...spec.sections];
    const [moved] = sections.splice(from, 1);
    if (!moved) return;
    sections.splice(to, 0, moved);
    patch({ ...spec, sections });
    setSelected(to);
  };

  const section = spec.sections[selected];

  // Fragments, not a `view` wrapper: the host owns the grid.
  //
  // This used to render its own `<div className="view rules">`, and App put that
  // inside `<div className="view reports">` — a grid inside a grid, so the outer
  // 3-column template got 2 children and the preview was squeezed into the
  // middle column while the rest sat empty. A component that renders columns
  // must not also render the grid that lays them out.
  return (
    <>
      <div className="col sections-col">
        <div className="pane-head">
          <span>报告区块</span>
          <span className="spacer" />
          <span className="tiny">{spec.sections.length}</span>
          <button
            className="btn tiny"
            onClick={() => setShowKinds((open) => !open)}
            title="加一个新的区块"
          >
            ＋区块
          </button>
        </div>
        <div className="pane-body">
          {showKinds ? (
            <div className="kind-palette">
              {(Object.keys(KIND_LABEL) as ReportSection["kind"][]).map((kind) => (
                <button key={kind} className="template" onClick={() => addSection(kind)}>
                  <span className="ico">＋</span>
                  <span>
                    <div className="name">{KIND_LABEL[kind].label}</div>
                    <div className="desc">{KIND_LABEL[kind].hint}</div>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <SectionCards
            sections={spec.sections}
            selected={selected}
            onSelect={setSelected}
            onMove={moveSection}
          />
        </div>
      </div>

      {section ? (
        <SectionEditor
          section={section}
          index={selected}
          issues={issues.filter((issue) => issue.section === selected)}
          readOnly={readOnly}
          onChange={(next) => updateSection(selected, next)}
          onDelete={() => removeSection(selected)}
        />
      ) : (
        <div className="col rule-main">
          <div className="pane-body">
            <div className="empty">这份报告还没有区块。点「＋区块」加一个。</div>
          </div>
        </div>
      )}

      <ReportPreview spec={spec} events={events} runId={runId} pack={pack} onOpenReport={onOpenReport} />
    </>
  );
}

/** The section list: fixed-height cards, reorder with the grip. */
const SECTION_CARD_HEIGHT = 60;
const SECTION_CARD_GAP = 6;

function SectionCards({
  sections,
  selected,
  onSelect,
  onMove,
}: {
  sections: ReportSection[];
  selected: number;
  onSelect: (index: number) => void;
  onMove: (from: number, to: number) => void;
}) {
  const sort = useDragSort(sections.length, SECTION_CARD_HEIGHT, SECTION_CARD_GAP, onMove);
  return (
    <div ref={sort.listRef} className="sortable rule-cards">
      {sections.map((section, index) => (
        <div
          key={index}
          className={["rule-card", "section-card", index === selected ? "sel" : "", sort.dragging === index ? "dragging" : ""]
            .filter(Boolean)
            .join(" ")}
          style={sort.itemStyle(index) as CSSProperties}
          onClick={() => onSelect(index)}
          title={KIND_LABEL[section.kind].hint}
        >
          <span className="grip" {...sort.handleProps(index)} title="按住拖动，调整顺序">
            ⠿
          </span>
          <div className="rule-card-main">
            <div className="rule-card-line">
              <span className="rule-card-name">{KIND_LABEL[section.kind].label}</span>
              <span className="spacer" />
              <span className="mono tiny muted">{section.kind}</span>
            </div>
            <div className="rule-card-line">
              <span className="rule-card-desc">{titleOf(section) || KIND_LABEL[section.kind].hint}</span>
            </div>
          </div>
        </div>
      ))}
      {sections.length === 0 ? <div className="empty">这份报告还没有区块。</div> : null}
    </div>
  );
}

function titleOf(section: ReportSection): string {
  return "title" in section && typeof section.title === "string" ? section.title : "";
}

/** One section's form. Everything a section can hold, and nothing it cannot. */
function SectionEditor({
  section,
  index,
  issues,
  readOnly,
  onChange,
  onDelete,
}: {
  section: ReportSection;
  index: number;
  issues: Array<{ path: string; message: string }>;
  readOnly?: boolean;
  onChange: (section: ReportSection) => void;
  onDelete: () => void;
}) {
  const set = (patch: Partial<ReportSection>) => onChange({ ...section, ...patch } as ReportSection);

  return (
    <div className="col rule-main">
      <div className="pane-head">
        <span>区块 {index + 1} · {KIND_LABEL[section.kind].label}</span>
        <span className="spacer" />
        <button className="btn tiny ghost danger" onClick={onDelete} title="删掉这个区块">
          删除
        </button>
      </div>

      <div className="pane-body rule-editor">
        {readOnly ? (
          <div className="notice">
            <span>这是内置报告。你在这里改的任何东西会先复制成一份自己的报告，内置的那份不会被改动。</span>
          </div>
        ) : null}

        {"title" in section ? (
          <label className="stack" style={{ gap: 4 }}>
            <span className="label">标题</span>
            <input
              className="field"
              value={section.title ?? ""}
              placeholder="区块的标题，可以用 {{facts.…}}"
              onChange={(event) => set({ title: event.target.value })}
            />
          </label>
        ) : null}

        {section.kind === "header" ? (
          <label className="stack" style={{ gap: 4 }}>
            <span className="label">副标题</span>
            <input
              className="field"
              value={section.subtitle ?? ""}
              placeholder="{{vars.headline}}"
              onChange={(event) => set({ subtitle: event.target.value || undefined })}
            />
          </label>
        ) : null}

        {section.kind === "verdict" ? (
          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={section.showFindings !== false}
              onChange={(event) => set({ showFindings: event.target.checked })}
            />
            <span className="label">同时列出触发的规则</span>
          </label>
        ) : null}

        {section.kind === "findings" ? (
          <>
            <label className="stack" style={{ gap: 4 }}>
              <span className="label">最低级别</span>
              <select
                className="field"
                value={section.minLevel ?? "low"}
                onChange={(event) => set({ minLevel: event.target.value as never })}
              >
                <option value="low">提示及以上</option>
                <option value="medium">警告及以上</option>
                <option value="high">只有严重</option>
              </select>
            </label>
            <label className="stack" style={{ gap: 4 }}>
              <span className="label">只看这些标签（逗号分隔，留空为全部）</span>
              <input
                className="field mono"
                value={(section.tags ?? []).join(", ")}
                placeholder="commands, failure"
                onChange={(event) =>
                  set({
                    tags: event.target.value
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          </>
        ) : null}

        {section.kind === "stats" ? (
          <div className="stack" style={{ gap: 6 }}>
            <span className="label">行</span>
            {section.rows.map((row, rowIndex) => (
              <div className="row" key={rowIndex} style={{ gap: 6 }}>
                <input
                  className="field"
                  style={{ flex: "0 0 30%" }}
                  value={row.label}
                  placeholder="标签"
                  onChange={(event) => {
                    const rows = [...section.rows];
                    rows[rowIndex] = { ...row, label: event.target.value };
                    set({ rows });
                  }}
                />
                <input
                  className="field mono"
                  value={row.value}
                  placeholder="{{facts.…}}"
                  onChange={(event) => {
                    const rows = [...section.rows];
                    rows[rowIndex] = { ...row, value: event.target.value };
                    set({ rows });
                  }}
                />
                <button
                  className="btn tiny ghost"
                  onClick={() => set({ rows: section.rows.filter((_, i) => i !== rowIndex) })}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn tiny"
              onClick={() => set({ rows: [...section.rows, { label: "新的一行", value: "" }] })}
            >
              ＋一行
            </button>
          </div>
        ) : null}

        {"source" in section ? (
          <label className="stack" style={{ gap: 4 }}>
            <span className="label">数据来源</span>
            <input
              className="field mono"
              value={section.source}
              placeholder="facts.commandFacts"
              onChange={(event) => set({ source: event.target.value })}
            />
            <span className="zh-hint">一个路径，比如 facts.files.created、facts.commandFacts、facts.mcp.servers。</span>
          </label>
        ) : null}

        {section.kind === "list" || section.kind === "text" ? (
          <label className="stack" style={{ gap: 4 }}>
            <span className="label">{section.kind === "list" ? "每一行的模板" : "每一段的模板"}</span>
            <input
              className="field mono"
              value={section.item ?? ""}
              placeholder="{{vars.row}}"
              onChange={(event) => set({ item: event.target.value || undefined })}
            />
            <span className="zh-hint">用 {"{{vars.row.…}}"} 取当前这一条的字段。</span>
          </label>
        ) : null}

        {section.kind === "table" ? (
          <div className="stack" style={{ gap: 6 }}>
            <span className="label">列</span>
            {section.columns.map((column, columnIndex) => (
              <div className="row" key={columnIndex} style={{ gap: 6 }}>
                <input
                  className="field"
                  style={{ flex: "0 0 26%" }}
                  value={column.header}
                  placeholder="表头"
                  onChange={(event) => {
                    const columns = [...section.columns];
                    columns[columnIndex] = { ...column, header: event.target.value };
                    set({ columns });
                  }}
                />
                <input
                  className="field mono"
                  value={column.cell}
                  placeholder="{{vars.row.command}}"
                  onChange={(event) => {
                    const columns = [...section.columns];
                    columns[columnIndex] = { ...column, cell: event.target.value };
                    set({ columns });
                  }}
                />
                <select
                  className="field"
                  style={{ flex: "0 0 90px" }}
                  value={column.width ?? "auto"}
                  onChange={(event) => {
                    const columns = [...section.columns];
                    columns[columnIndex] = { ...column, width: event.target.value as never };
                    set({ columns });
                  }}
                >
                  <option value="auto">自动</option>
                  <option value="narrow">窄</option>
                  <option value="wide">宽</option>
                </select>
                <button
                  className="btn tiny ghost"
                  onClick={() => set({ columns: section.columns.filter((_, i) => i !== columnIndex) })}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn tiny"
              onClick={() => set({ columns: [...section.columns, { header: "新列", cell: "{{vars.row}}" }] })}
            >
              ＋一列
            </button>
          </div>
        ) : null}

        {/* A section that *can* hold a filter always shows the control, even when
            it has none yet — otherwise the key never exists and could never be
            added. That is the bug that made `in` the wrong test here. */}
        {FILTERABLE.has(section.kind) ? (
          <div className="stack" style={{ gap: 4 }}>
            <span className="label">筛选（可选）</span>
            <FilterEditor
              filter={"filter" in section ? section.filter : undefined}
              onChange={(filter) => set({ filter } as Partial<ReportSection>)}
            />
          </div>
        ) : null}

        {"evidence" in section ? (
          <label className="stack" style={{ gap: 4 }}>
            <span className="label">每一条的证据字段（可选）</span>
            <input
              className="field mono"
              value={section.evidence ?? ""}
              placeholder="evidence"
              onChange={(event) => set({ evidence: event.target.value || undefined } as Partial<ReportSection>)}
            />
            <span className="zh-hint">填 evidence，报告里每一行就能点回对应的事件。</span>
          </label>
        ) : null}

        {"limit" in section ? (
          <label className="stack" style={{ gap: 4 }}>
            <span className="label">最多显示几条</span>
            <input
              className="field mono"
              type="number"
              value={section.limit ?? 40}
              onChange={(event) => set({ limit: Number(event.target.value) || undefined })}
            />
          </label>
        ) : null}

        {"empty" in section ? (
          <label className="stack" style={{ gap: 4 }}>
            <span className="label">没有内容时说什么</span>
            <input
              className="field"
              value={section.empty ?? ""}
              placeholder="没有。"
              onChange={(event) => set({ empty: event.target.value || undefined })}
            />
          </label>
        ) : null}

        {issues.length > 0 ? (
          <section className="block issues-block">
            <header className="block-head">
              <span className="block-title" style={{ color: "var(--high)" }}>
                有 {issues.length} 处需要处理
              </span>
            </header>
            {issues.map((issue, issueIndex) => (
              <div className="issue" key={issueIndex}>
                <span className="path">{issue.path}</span>
                <span>{issue.message}</span>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A filter, in the plainest form that covers the real need: one field, one
 * operator, one value.
 *
 * The engine's `When` can hold several conditions and a combinator, and a UI for
 * that is the rule editor. Here the point is the common case — "only what
 * changed under `company/`" — so one row, and a note that more is a rule's job.
 */
function FilterEditor({
  filter,
  onChange,
}: {
  filter: SectionFilter | undefined;
  onChange: (filter: SectionFilter | undefined) => void;
}) {
  const condition = filter?.conditions?.[0];
  const field = condition && "field" in condition ? condition.field : "";
  const op: string = condition && "op" in condition ? String(condition.op) : "glob";
  const value = condition && "value" in condition ? String(condition.value ?? "") : "";

  const set = (nextField: string, nextOp: string, nextValue: string) => {
    if (nextField.trim() === "") {
      onChange(undefined);
      return;
    }
    onChange({ conditions: [{ field: nextField, op: nextOp as never, value: nextValue }] });
  };

  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="field mono"
          style={{ flex: "0 0 34%" }}
          value={field}
          placeholder="path"
          onChange={(event) => set(event.target.value, op, value)}
        />
        <select
          className="field"
          style={{ flex: "0 0 110px" }}
          value={op}
          onChange={(event) => set(field, event.target.value, value)}
        >
          <option value="glob">匹配路径</option>
          <option value="eq">等于</option>
          <option value="ne">不等于</option>
          <option value="contains">包含</option>
          <option value="startsWith">开头是</option>
          <option value="endsWith">结尾是</option>
          <option value="matches">匹配正则</option>
          <option value="gte">≥</option>
          <option value="lte">≤</option>
        </select>
        <input
          className="field mono"
          value={value}
          placeholder="company/**"
          onChange={(event) => set(field, op, event.target.value)}
        />
        <button className="btn tiny ghost" onClick={() => onChange(undefined)} title="去掉筛选">
          ✕
        </button>
      </div>
      <span className="zh-hint">
        留空就是不过滤。这里只有一行；要「A 而且 B」，那属于规则的 `where`，不是报告。
      </span>
    </div>
  );
}

/** The spec, rendered against the selected run — the answer, not a mock. */
function ReportPreview({
  spec,
  events,
  runId,
  pack,
  onOpenReport,
}: {
  spec: ReportSpec;
  events: ChartEvent[];
  runId?: string;
  pack: RulePack;
  onOpenReport: () => void;
}) {
  const preview = useMemo(() => {
    if (events.length === 0) return undefined;
    const observation = observeRun(
      events,
      runOf(events, runId),
      { pack, phase: "settled" },
    );
    return { observation, rendered: renderReport(spec, { facts: observation.facts, attention: observation.attention }) };
  }, [spec, events, runId, pack]);

  const templateIssues = useMemo(() => {
    if (!preview) return [];
    return checkSpecTemplates(spec, preview.observation);
  }, [spec, preview]);

  return (
    <div className="col report-preview-col">
      <div className="pane-head">
        <span>预览 · 这一轮</span>
        <span className="spacer" />
        <button className="btn tiny ghost" onClick={onOpenReport} title="在报告面板里播放">
          在报告里播放 →
        </button>
      </div>
      <div className="pane-body report-scroll">
        {templateIssues.length > 0 ? (
          <div className="stack" style={{ gap: 3, marginBottom: 10 }}>
            <div className="fired-head" style={{ color: "var(--high)" }}>
              <span>{templateIssues.length} 处取不到值</span>
            </div>
            {templateIssues.map((issue, index) => (
              <div className="issue" key={index}>
                <span className="path mono">{issue.path}</span>
                <span>{issue.message}</span>
              </div>
            ))}
          </div>
        ) : null}
        {preview ? (
          <ReportDocument report={preview.rendered} />
        ) : (
          <div className="empty">这段事件流里还没有一轮运行。</div>
        )}
      </div>
    </div>
  );
}

function runOf(events: ChartEvent[], runId?: string): Run {
  const runs = deriveRuns(events);
  return runs.find((run) => run.id === runId) ?? runs[runs.length - 1]!;
}

/** Every template in the spec, checked against a real observation. */
function checkSpecTemplates(
  spec: ReportSpec,
  observation: ReturnType<typeof observeRun>,
): Array<{ path: string; message: string }> {
  const context = {
    facts: observation.facts,
    live: {},
    vars: { outcome: "", headline: "", row: {} },
  };
  const out: Array<{ path: string; message: string }> = [];
  const check = (path: string, template: string | undefined) => {
    if (!template) return;
    for (const issue of checkTemplate(template, context)) {
      out.push({ path, message: issue.message });
    }
  };

  check("title", spec.title);
  spec.sections.forEach((section, index) => {
    if ("title" in section) check(`sections[${index}].title`, section.title);
    if (section.kind === "header") check(`sections[${index}].subtitle`, section.subtitle);
    if (section.kind === "stats") {
      section.rows.forEach((row, rowIndex) => check(`sections[${index}].rows[${rowIndex}].value`, row.value));
    }
    if (section.kind === "table") {
      section.columns.forEach((column, columnIndex) =>
        check(`sections[${index}].columns[${columnIndex}].cell`, column.cell),
      );
    }
    if (section.kind === "list") check(`sections[${index}].item`, section.item);
    if (section.kind === "text" && section.item) check(`sections[${index}].item`, section.item);
  });
  return out;
}
