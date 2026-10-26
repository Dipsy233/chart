/**
 * The shell. Three views, one state:
 *
 *   Rules   — packs | rules | the selected rule, with a findings strip underneath
 *   Report  — the run report, full width, as a document
 *   Events  — the event stream as a form, with what it adds up to on the right
 *
 * Every edit goes straight through `PackStore.save(..., { force: true })`: the
 * store validates, the editor shows the problems, and a half-typed rule never
 * blocks anything.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PACK,
  PackStore,
  newRule,
  observe,
  parsePack,
  removeRule,
  report,
  serializePack,
  suggestId,
  upsertRule,
  type ChartEvent,
  type Observation,
  type PackSummary,
  type Rule,
  type RulePack,
} from "../../src/index.ts";
import { LIVE_REPORT, SETTLED_REPORT } from "../../src/report/defaults.ts";
import { localStoragePackIO, downloadPack } from "./lib/storage.ts";
import { DEMOS } from "./lib/demo.ts";
import { renumber } from "./lib/events.ts";
import { RuleEditor } from "./components/RuleEditor.tsx";
import { ReportDocument } from "./components/ReportDocument.tsx";
import { EventStreamEditor } from "./components/EventStreamEditor.tsx";

const store = new PackStore(localStoragePackIO(), DEFAULT_PACK);

type View = "rules" | "report" | "events";

export function App() {
  const [view, setView] = useState<View>("report");
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [packName, setPackName] = useState<string | undefined>(undefined);
  const [pack, setPack] = useState<RulePack>(DEFAULT_PACK);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [demoId, setDemoId] = useState(DEMOS[0]!.id);
  const [events, setEvents] = useState<ChartEvent[]>(() => renumber(DEMOS[0]!.build()));
  const [phase, setPhase] = useState<"live" | "settled" | "both">("settled");
  const [anchor, setAnchor] = useState<number | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const eventsInput = useRef<HTMLInputElement>(null);
  const packInput = useRef<HTMLInputElement>(null);

  /* ── load ───────────────────────────────────────────────── */

  const refreshPacks = useCallback(async () => {
    setPacks(await store.list());
  }, []);

  useEffect(() => {
    void (async () => {
      await refreshPacks();
      const active = await store.activeName();
      setPackName(active);
      const loaded = await store.load(active).catch(() => DEFAULT_PACK);
      setPack(loaded);
      setSelectedId(loaded.rules[0]?.id);
    })();
  }, [refreshPacks]);

  /* ── persistence ────────────────────────────────────────── */

  const persist = useCallback(
    async (name: string | undefined, next: RulePack) => {
      setPack(next);
      if (!name) return; // the built-in defaults are read-only
      try {
        await store.save(name, next, { force: true });
        await refreshPacks();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [refreshPacks],
  );

  const updateRule = useCallback(
    (rule: Rule) => {
      setSelectedId(rule.id);
      void persist(packName, upsertRule(pack, rule));
    },
    [pack, packName, persist],
  );

  /* ── packs ──────────────────────────────────────────────── */

  const openPack = async (name: string | undefined) => {
    const loaded = await store.load(name).catch(() => DEFAULT_PACK);
    setPackName(name);
    setPack(loaded);
    setSelectedId(loaded.rules[0]?.id);
    setMessage(undefined);
  };

  const createPack = async () => {
    const name = window.prompt("Pack name (letters, digits, . - _)", "work");
    if (!name) return;
    try {
      const created = await store.create(name);
      await refreshPacks();
      setPackName(name);
      setPack(created);
      setSelectedId(created.rules[0]?.id);
      setMessage(`created and activated “${name}”`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const activatePack = async (name: string) => {
    try {
      await store.activate(name);
      await refreshPacks();
      setMessage(`active pack: ${name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const deletePack = async (name: string) => {
    if (!window.confirm(`Delete pack “${name}”?`)) return;
    await store.remove(name);
    await refreshPacks();
    if (packName === name) await openPack(undefined);
  };

  /* ── rules ──────────────────────────────────────────────── */

  const addRule = () => {
    const base = suggestId(`rule ${pack.rules.length + 1}`);
    let id = base;
    let counter = 2;
    while (pack.rules.some((rule) => rule.id === id)) id = `${base}-${counter++}`;
    updateRule(newRule(id));
    setView("rules");
  };

  const moveRule = (id: string, direction: -1 | 1) => {
    const index = pack.rules.findIndex((rule) => rule.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= pack.rules.length) return;
    const rules = [...pack.rules];
    const [moved] = rules.splice(index, 1);
    rules.splice(target, 0, moved!);
    void persist(packName, { ...pack, rules });
  };

  /* ── simulation ─────────────────────────────────────────── */

  const observation: Observation | undefined = useMemo(() => {
    if (events.length === 0) return undefined;
    try {
      return observe(events, {
        pack,
        phase: phase === "both" ? undefined : phase,
        live: anchor === undefined ? {} : { nowMs: anchor },
        anchor,
      });
    } catch {
      return undefined;
    }
  }, [events, pack, phase, anchor]);

  const rendered = useMemo(() => {
    if (!observation) return undefined;
    const spec = phase === "live" ? LIVE_REPORT : SETTLED_REPORT;
    return report(observation, spec, anchor === undefined ? {} : { nowMs: anchor });
  }, [observation, phase, anchor]);

  const firedIds = new Set(observation?.findings.map((finding) => finding.ruleId) ?? []);
  const selectedRule = pack.rules.find((rule) => rule.id === selectedId);
  const packIssues = packs.find((summary) => summary.name === packName)?.issues.length ?? 0;

  /* ── render ─────────────────────────────────────────────── */

  return (
    <div className="shell">
      <div className="topbar">
        <span className="brand">CHART</span>
        <span className="brand-sub">Regimen</span>

        <div className="views">
          <button className={view === "report" ? "on" : ""} onClick={() => setView("report")}>
            Report
          </button>
          <button className={view === "rules" ? "on" : ""} onClick={() => setView("rules")}>
            Rules
          </button>
          <button className={view === "events" ? "on" : ""} onClick={() => setView("events")}>
            Events
          </button>
        </div>

        <span className="spacer" />

        <span className="label">run</span>
        <select
          className="field"
          style={{ width: 220 }}
          value={demoId}
          onChange={(event) => {
            const demo = DEMOS.find((candidate) => candidate.id === event.target.value);
            if (!demo) return;
            setDemoId(demo.id);
            setEvents(renumber(demo.build()));
            setAnchor(undefined);
          }}
        >
          {DEMOS.map((demo) => (
            <option key={demo.id} value={demo.id}>
              {demo.label}
            </option>
          ))}
        </select>
        <button className="btn tiny" onClick={() => eventsInput.current?.click()}>
          load…
        </button>
        <input
          ref={eventsInput}
          type="file"
          accept=".json"
          style={{ display: "none" }}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            try {
              const parsed = JSON.parse(await file.text()) as unknown;
              const list = Array.isArray(parsed) ? parsed : ((parsed as { events?: unknown[] }).events ?? []);
              setEvents(renumber(list as ChartEvent[]));
              setAnchor(undefined);
              setMessage(`loaded ${list.length} events`);
            } catch (error) {
              setMessage(`cannot read events: ${String(error)}`);
            }
          }}
        />

        <span className="label">phase</span>
        <select
          className="field"
          style={{ width: 104 }}
          value={phase}
          onChange={(event) => setPhase(event.target.value as never)}
        >
          <option value="settled">settled</option>
          <option value="live">live</option>
          <option value="both">all rules</option>
        </select>

        <button className="btn tiny" onClick={() => setAnchor(undefined)} title="Judge against the end of the run">
          run end
        </button>
        <button
          className="btn tiny"
          onClick={() => setAnchor((observation?.facts.lastActivityAt ?? Date.now()) + 5 * 60_000)}
          title="Five minutes later: watch live windows go quiet"
        >
          +5m
        </button>

        {packIssues > 0 ? <span className="chip high">{packIssues} pack issue</span> : null}
        {observation && observation.errors.length > 0 ? (
          <span className="chip high">{observation.errors.length} rule error</span>
        ) : null}
        {message ? <span className="tiny muted">{message}</span> : null}
      </div>

      {/* ══ report ═══════════════════════════════════════════ */}
      {view === "report" ? (
        <div className="view" style={{ display: "block", overflowY: "auto", background: "var(--bg)" }}>
          {rendered && observation ? (
            <>
              <div style={{ maxWidth: 1080, margin: "0 auto", padding: "18px 32px 0", display: "flex", gap: 12 }}>
                <span className="tiny muted">
                  {observation.run.id} · {observation.facts.commands.total} commands ·{" "}
                  {observation.facts.files.created.length + observation.facts.files.modified.length} files touched
                </span>
                <span className="spacer" />
                <span className="tiny muted">
                  judged by <span className="mono">{packName ?? "built-in defaults"}</span>
                  {anchor === undefined ? " at run end" : ` at ${new Date(anchor).toLocaleString()}`}
                </span>
                <button className="btn tiny" onClick={() => setView("events")}>
                  edit the stream →
                </button>
              </div>
              <ReportDocument report={rendered} />
            </>
          ) : (
            <div style={{ padding: 40 }} className="empty">
              No run to report on. Load a demo, or build a stream in the Events view.
            </div>
          )}
        </div>
      ) : null}

      {/* ══ rules ════════════════════════════════════════════ */}
      {view === "rules" ? (
        <div className="view rules">
          {/* packs */}
          <div className="col">
            <div className="pane-head">
              <span>packs</span>
              <span className="spacer" />
              <button className="btn tiny" onClick={createPack} title="Copy the defaults into a new pack">
                +
              </button>
            </div>
            <div className="pane-body stack" style={{ gap: 2 }}>
              <div className={`pack${packName === undefined ? " sel" : ""}`} onClick={() => void openPack(undefined)}>
                <span className="dot">{packName === undefined ? "●" : ""}</span>
                <span className="name">built-in defaults</span>
              </div>
              {packs.map((summary) => (
                <div
                  key={summary.name}
                  className={`pack${packName === summary.name ? " sel" : ""}`}
                  onClick={() => void openPack(summary.name)}
                >
                  <span className="dot">{summary.active ? "●" : ""}</span>
                  <span className="name">{summary.name}</span>
                  {summary.issues.length > 0 ? <span className="bad">!</span> : null}
                  <button
                    className="btn tiny"
                    title={summary.active ? "this is the active pack" : "make active"}
                    onClick={(event) => {
                      event.stopPropagation();
                      void activatePack(summary.name);
                    }}
                  >
                    {summary.active ? "✓" : "○"}
                  </button>
                  <button
                    className="btn tiny danger"
                    onClick={(event) => {
                      event.stopPropagation();
                      void deletePack(summary.name);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {packs.length === 0 ? (
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  No packs yet. “+” copies the built-in defaults into an editable pack.
                </div>
              ) : null}

              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn tiny" onClick={() => packInput.current?.click()}>
                  import
                </button>
                <input
                  ref={packInput}
                  type="file"
                  accept=".json"
                  style={{ display: "none" }}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    try {
                      const parsed = parsePack(await file.text());
                      const name = file.name.replace(/\.json$/i, "");
                      await store.save(name, parsed, { force: true });
                      await refreshPacks();
                      await openPack(name);
                      setMessage(`imported “${name}”`);
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : String(error));
                    }
                  }}
                />
                {packName ? (
                  <button
                    className="btn tiny"
                    onClick={() => downloadPack(packName, serializePack(pack))}
                    title="Download for .chart/rules/"
                  >
                    export
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          {/* rules */}
          <div className="col">
            <div className="pane-head">
              <span>rules</span>
              <span className="spacer" />
              <span className="tiny">{pack.rules.length}</span>
              <button className="btn tiny" onClick={addRule} title="Add a rule">
                +
              </button>
            </div>
            <div className="pane-body stack" style={{ gap: 2 }}>
              {pack.rules.map((rule) => {
                const off = rule.enabled === false || rule.emit.level === "none";
                return (
                  <div
                    key={rule.id}
                    className={[
                      "rule",
                      rule.id === selectedId ? "sel" : "",
                      firedIds.has(rule.id) ? "fired" : "",
                      off ? "off" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => setSelectedId(rule.id)}
                  >
                    <span className="id">{rule.id}</span>
                    <span className="row" style={{ gap: 2 }}>
                      <button
                        className="btn tiny"
                        onClick={(event) => {
                          event.stopPropagation();
                          moveRule(rule.id, -1);
                        }}
                        title="Higher priority"
                      >
                        ▲
                      </button>
                      <button
                        className="btn tiny"
                        onClick={(event) => {
                          event.stopPropagation();
                          moveRule(rule.id, 1);
                        }}
                        title="Lower priority"
                      >
                        ▼
                      </button>
                    </span>
                    <span className="meta">
                      <span className={`chip ${off ? "off" : rule.emit.level}`}>{off ? "off" : rule.emit.level}</span>
                      {rule.phase && rule.phase !== "both" ? <span className={`chip ${rule.phase}`}>{rule.phase}</span> : null}
                      <span className="txt">{rule.emit.title}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* the selected rule */}
          <div className="col">
            {selectedRule ? (
              <RuleEditor
                rule={selectedRule}
                pack={pack}
                events={events}
                anchor={anchor}
                fired={firedIds.has(selectedRule.id)}
                onChange={updateRule}
                onDelete={() => {
                  const next = removeRule(pack, selectedRule.id);
                  setSelectedId(next.rules[0]?.id);
                  void persist(packName, next);
                }}
                onDuplicate={() =>
                  updateRule({
                    ...structuredClone(selectedRule),
                    id: `${selectedRule.id}.copy`,
                    name: `${selectedRule.name ?? selectedRule.id} (copy)`,
                  })
                }
              />
            ) : (
              <div className="pane-body">
                <div className="empty">
                  {pack.rules.length === 0 ? "This pack has no rules. “+” adds one." : "Select a rule."}
                </div>
              </div>
            )}
          </div>

          {/* the findings strip: editing feedback, not the report */}
          <div className="strip">
            <span className={`chip ${observation?.attention.level ?? "none"}`}>
              {observation?.attention.level ?? "none"}
            </span>
            {observation && observation.findings.length > 0 ? (
              observation.findings.map((finding) => (
                <span className="item" key={finding.ruleId}>
                  <span className={`chip ${finding.level}`}>{finding.level}</span>
                  <span className="t">{finding.title}</span>
                </span>
              ))
            ) : (
              <span className="muted tiny">Nothing fires on this run.</span>
            )}
            <span className="spacer" />
            <button className="btn tiny" onClick={() => setView("report")}>
              open the report →
            </button>
          </div>
        </div>
      ) : null}

      {/* ══ events ═══════════════════════════════════════════ */}
      {view === "events" ? (
        <EventStreamEditor
          events={events}
          observation={observation}
          onChange={setEvents}
          onOpenReport={() => setView("report")}
          onSelectRule={(id) => {
            setSelectedId(id);
            setView("rules");
          }}
        />
      ) : null}
    </div>
  );
}
