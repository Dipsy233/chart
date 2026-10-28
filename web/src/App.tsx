/**
 * The shell: a top bar, three views, and one shared state.
 *
 *   监护报告   runs | events | the report (playback) | the pack
 *   规则编辑   packs | rules (drag to reorder) | the rule
 *   事件流     runs | events | the event
 *
 * The top bar switches views. What is being observed — the 监护对象 — lives in
 * the 事件会话 column of the report and event views now, where every session is
 * visible at once instead of one chosen line.
 *
 * The shared state is the session's events, the selected pack, and the selected
 * run. Judgement happens only in the report view; the other two views edit data.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PACK,
  PACK_NAME_RE,
  PackStore,
  isIdTaken,
  moveRuleTo,
  parsePack,
  removeRule,
  replaceRuleAt,
  serializePack,
  upsertRule,
  validatePack,
  validateSpec,
  type ChartEvent,
  type PackSummary,
  type Rule,
  type RulePack,
} from "../../src/index.ts";
import { adaptivePackIO, backendKind, downloadPack, loadUserSessions, saveUserSessions, type StoredSession, type Backend } from "./lib/storage.ts";
import {
  activeReportName,
  downloadReport,
  listReports,
  parseSpec,
  readReport,
  removeReport,
  saveReport,
  setActiveReport,
  type ReportSummary,
} from "./lib/storage.ts";
import type { ReportSpec } from "../../src/report/spec.ts";
import { CLASSIC_REPORT } from "../../src/report/classic.ts";
import type { MetricsFrameLike } from "../../src/core/live.ts";
import { DEMOS } from "./lib/demo.ts";
import { newEvent, renumber } from "./lib/events.ts";
import { pickRunView, runViews, type RunView } from "./lib/runs.ts";
import { RULE_TEMPLATES } from "./lib/plain.ts";
import { PackColumn } from "./components/PackColumn.tsx";
import { SessionColumn, type Subject } from "./components/SessionColumn.tsx";
import { NewSessionDialog, type AbsenceImport, type SessionMode } from "./components/NewSessionDialog.tsx";
import { ConfirmDialog, PromptDialog } from "./components/PromptDialog.tsx";
import { JsonDialog } from "./components/JsonDialog.tsx";
import { RuleCardList } from "./components/RuleCardList.tsx";
import { RuleEditor } from "./components/RuleEditor.tsx";
import { ReportView } from "./components/ReportView.tsx";
import { ReportEditor } from "./components/ReportEditor.tsx";
import { EventStreamEditor } from "./components/EventStreamEditor.tsx";

const store = new PackStore(adaptivePackIO(), DEFAULT_PACK);

type View = "report" | "rules" | "reports" | "events";

/** Which name dialog is open, and what to do with the answer. */
type PackPrompt =
  | { kind: "create" }
  | { kind: "apply"; pack: RulePack };

/** A name the dialog can offer, that does not collide with an existing pack. */
function freePackName(taken: readonly string[], base = "work"): string {
  if (!taken.includes(base)) return base;
  let counter = 2;
  while (taken.includes(`${base}-${counter}`)) counter += 1;
  return `${base}-${counter}`;
}

/** The same idea for a session name: `我的实验`, then `我的实验 2`, … */
function freeSessionName(taken: readonly string[], base: string): string {
  if (!taken.includes(base)) return base;
  let counter = 2;
  while (taken.includes(`${base} ${counter}`)) counter += 1;
  return `${base} ${counter}`;
}

/** The same rules the store enforces, said in Chinese for the dialog. */
function packNameProblem(name: string, taken: readonly string[], allowExisting: boolean): string | undefined {
  if (name === "") return "名字不能为空";
  if (!PACK_NAME_RE.test(name)) return "只能用字母、数字、. - _，最多 64 个字符";
  if (name === "active") return "「active」是保留名，换一个";

  if (!allowExisting && taken.includes(name)) return `已经有名为「${name}」的规则包了`;
  return undefined;
}

/**
 * One row in the report list.
 *
 * The same markup the pack column uses — the dot is the switch, the row opens
 * the document — because they are the same interaction on a different kind of
 * file. The first version of this row put two lines inside `.pack-name`, which is
 * a single-line ellipsis box, so the label and its hint overlapped and the row
 * read as broken.
 */
function ReportRow({
  label,
  count,
  hint,
  active,
  selected,
  issues,
  onSelect,
  onActivate,
  onDelete,
}: {
  label: string;
  count: number;
  hint?: string;
  active: boolean;
  selected: boolean;
  issues?: number;
  onSelect: () => void;
  onActivate: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className={`pack-row${selected ? " sel" : ""}`} onClick={onSelect} title={hint ?? label}>
      <button
        type="button"
        className={`pack-dot${active ? " on" : ""}`}
        aria-pressed={active}
        aria-label={active ? `${label} 已是生效报告` : `把 ${label} 设为生效报告`}
        title={active ? "当前生效的报告" : "点一下设为生效"}
        onClick={(event) => {
          event.stopPropagation();
          onActivate();
        }}
      />
      <span className="pack-name">{label}</span>
      {issues ? <span className="pack-bad" title={`${issues} 处问题`}>!</span> : null}
      <span className="pack-count">{count}</span>
      {onDelete ? (
        <button
          className="btn tiny ghost danger"
          title="删除这份报告"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

/**
 * The report names that are not files.
 *
 * There is exactly one: `@classic`, Absence's original layout written as a spec.
 * It is read-only, and it is the **default** — a fresh install has no report of
 * its own, so the shipped document is the one in force. It is addressable by
 * name so that *activating* it is a normal choice rather than "clear the
 * pointer".
 *
 * (`@default` used to be a second built-in, the editor's own Chinese spec. Two
 * built-ins whose only difference was the language of their section titles made
 * the list read like a bug, so it is gone: the renderer translates.)
 */
const BUILT_IN_REPORTS: Record<string, ReportSpec> = {
  "@classic": CLASSIC_REPORT,
};

/** The spec a fresh install uses. */
const DEFAULT_REPORT = CLASSIC_REPORT;
const DEFAULT_REPORT_NAME = "@classic";

/** A name → the spec it refers to, built-in or stored. The one lookup. */
function resolveSpec(name: string | undefined): ReportSpec | undefined {
  if (name === undefined) return DEFAULT_REPORT;
  return BUILT_IN_REPORTS[name] ?? readReport(name);
}

/** Whether a name is a built-in (read-only) report. */
function isBuiltInReport(name: string | undefined): boolean {
  return name === undefined || name in BUILT_IN_REPORTS;
}

export function App() {
  const [view, setView] = useState<View>("report");
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [packName, setPackName] = useState<string | undefined>(undefined);
  const [pack, setPack] = useState<RulePack>(DEFAULT_PACK);
  const [selectedRuleId, setSelectedRuleId] = useState<string | undefined>(undefined);

  /* ── report specs ───────────────────────────────────────────
   *
   * A report is data (docs/REPORTS.md), so "customise the report" is a storage
   * question. The built-in is `CLASSIC_REPORT` — the original Absence layout
   * expressed as a spec, and the default. Editing it forks a named copy first,
   * the same way the built-in rule pack forks.
   */
  const [reports, setReports] = useState<ReportSummary[]>(() => listReports());
  /**
   * Two different names, deliberately.
   *
   *   reportName  — which report the *editor* is looking at
   *   activeName  — which report the *report view* renders by default
   *
   * The first version kept only `reportName`, so "I opened this to look at it"
   * and "this is the one that is in force" were the same fact. That produced two
   * visible bugs: a built-in that was selected counted as active (its dot lit
   * without ever being activated), and activating a built-in wrote `undefined`
   * to the pointer — so the choice was lost on reload and the view fell back.
   *
   * The pointer stores a name, and `@classic` is a name like any other:
   * `undefined` means "nothing chosen", which resolves to the built-in default.
   */
  const [activeName, setActiveName] = useState<string | undefined>(() => activeReportName());
  /** What the report view renders: the report that is *in force*. */
  const [activeSpec, setActiveSpec] = useState<ReportSpec>(
    () => resolveSpec(activeReportName()) ?? DEFAULT_REPORT,
  );
  /** What the editor is looking at. Opening a report does not change the above. */
  const [reportName, setReportName] = useState<string | undefined>(() => activeReportName() ?? DEFAULT_REPORT_NAME);
  const [reportSpec, setReportSpec] = useState<ReportSpec>(
    () => resolveSpec(activeReportName()) ?? DEFAULT_REPORT,
  );
  const [reportPrompt, setReportPrompt] = useState<{ kind: "create"; from: ReportSpec } | undefined>(undefined);
  const [reportToDelete, setReportToDelete] = useState<string | undefined>(undefined);
  const [reportJsonOpen, setReportJsonOpen] = useState(false);
  const reportInput = useRef<HTMLInputElement>(null);

  const [demoId, setDemoId] = useState(DEMOS[0]!.id);
  const [userSessions, setUserSessions] = useState<StoredSession[]>(() => loadUserSessions());
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<string | undefined>(undefined);
  const [events, setEvents] = useState<ChartEvent[]>(() => renumber(DEMOS[0]!.build()));
  const [metrics, setMetrics] = useState<MetricsFrameLike[]>(() => DEMOS[0]!.metrics?.() ?? []);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [selectedEventIndex, setSelectedEventIndex] = useState<number | undefined>(undefined);
  const [allEventsMode, setAllEventsMode] = useState(false);

  const [templateOpen, setTemplateOpen] = useState(false);
  const [packJsonOpen, setPackJsonOpen] = useState(false);
  const [packPrompt, setPackPrompt] = useState<PackPrompt | undefined>(undefined);
  const [packToDelete, setPackToDelete] = useState<string | undefined>(undefined);
  const [backend, setBackend] = useState<Backend | undefined>(undefined);
  const [toast, setToast] = useState<{ text: string; tone: "info" | "error" } | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);
  const packInput = useRef<HTMLInputElement>(null);

  const notify = useCallback((text: string, tone: "info" | "error" = "info") => {
    setToast({ text, tone });
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(undefined), 4200);
  }, []);

  /* ── load ───────────────────────────────────────────────── */

  const refreshPacks = useCallback(async () => {
    setPacks(await store.list());
  }, []);

  useEffect(() => {
    void (async () => {
      setBackend(await backendKind());
      await refreshPacks();
      const active = await store.activeName();
      setPackName(active);
      const loaded = await store.load(active).catch(() => DEFAULT_PACK);
      setPack(loaded);
      setSelectedRuleId(loaded.rules[0]?.id);
    })();
  }, [refreshPacks]);

  /* ── the run, derived from the stream ───────────────────── */

  const views = useMemo(() => runViews(events), [events]);
  const selectedView = pickRunView(views, runId);

  // Keep the event panel pointing at something real whenever the scope changes.
  useEffect(() => {
    if (view !== "events") return;
    if (!selectedView || (allEventsMode ? events.length === 0 : selectedView.eventCount === 0)) {
      setSelectedEventIndex(undefined);
      return;
    }
    setSelectedEventIndex((current) => {
      if (current === undefined) return allEventsMode ? 0 : selectedView.run.fromIndex;
      if (allEventsMode) return Math.min(current, events.length - 1);
      if (current >= selectedView.run.fromIndex && current <= selectedView.run.toIndex) return current;
      return selectedView.run.fromIndex;
    });
  }, [view, selectedView, allEventsMode, events.length]);

  /* ── persistence ────────────────────────────────────────── */

  // Selection is a *position*, not an id.
  //
  // The id field in the editor fires per keystroke, so keying the selection on
  // the id meant a half-typed id selected nothing and the panel jumped back to
  // `rules[0]` — the user's edit landing in a different rule than the one they
  // were looking at. The id is a value; the index is the identity.
  const selectedIndex = useMemo(() => {
    if (selectedRuleId === undefined) return 0;
    const at = pack.rules.findIndex((rule) => rule.id === selectedRuleId);
    return at === -1 ? 0 : at;
  }, [pack, selectedRuleId]);

  const persist = useCallback(
    async (name: string | undefined, next: RulePack) => {
      setPack(next);
      // The built-in defaults and the example pack are not files: an edit has to
      // fork into a real pack first, and the editor says so.
      if (!name) return;
      try {
        await store.save(name, next, { force: true });
        await refreshPacks();
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
    [notify, refreshPacks],
  );

  const updateRule = useCallback(
    (rule: Rule) => {
      // Editing is positional: the rule being edited is the one at
      // `selectedIndex`, whatever its id says right now. Keying on the id made a
      // rename append a new rule (see `replaceRuleAt` in the editor model).
      const next = replaceRuleAt(pack, selectedIndex, rule);
      setSelectedRuleId(rule.id);
      void persist(packName, next);
    },
    [pack, packName, persist, selectedIndex],
  );

  const moveRule = useCallback(
    (from: number, to: number) => {
      void persist(packName, moveRuleTo(pack, from, to));
    },
    [pack, packName, persist],
  );

  /* ── reports ────────────────────────────────────────────── */

  /** Open a report in the editor. Does not change what is in force. */
  const openReport = (name: string | undefined) => {
    const spec = resolveSpec(name);
    if (!spec) {
      notify(`找不到报告「${name}」`, "error");
      return;
    }
    setReportName(name ?? DEFAULT_REPORT_NAME);
    setReportSpec(spec);
  };

  /**
   * Make a report the one the report view renders. Also opens it, because
   * switching what is in force without showing it would be a surprise.
   */
  const activateReport = (name: string | undefined) => {
    const spec = resolveSpec(name);
    if (!spec) {
      notify(`找不到报告「${name}」`, "error");
      return;
    }
    // `undefined` is the pointer's "nothing chosen" state, which resolves to the
    // built-in default. A built-in that is chosen on purpose is stored by name,
    // so it survives a reload — this is what used to be written as `undefined`
    // and lost.
    setActiveReport(name);
    setActiveName(name);
    setActiveSpec(spec);
    setReportName(name ?? DEFAULT_REPORT_NAME);
    setReportSpec(spec);
    setReports(listReports());
  };

  /**
   * Persist a spec edit.
   *
   * A built-in spec is not a file, so an edit forks it: the dialog asks for a
   * name, and the copy becomes the active report. That is the same rule the
   * rule packs follow, for the same reason — a user cannot lose a shipped
   * document by editing it.
   */
  const persistReport = (spec: ReportSpec) => {
    if (isBuiltInReport(reportName) || reportName === undefined) {
      setReportPrompt({ kind: "create", from: spec });
      return;
    }
    const issues = saveReport(reportName, spec);
    if (issues.length > 0) {
      notify(`${issues.length} 处问题，已拒绝保存：${issues[0]}`, "error");
      return;
    }
    setReportSpec(spec);
    if (activeName === reportName) setActiveSpec(spec);
    setReports(listReports());
  };

  const createReport = (name: string, from: ReportSpec) => {
    const spec: ReportSpec = { ...structuredClone(from), id: name };
    const issues = saveReport(name, spec);
    if (issues.length > 0) {
      notify(`${issues.length} 处问题：${issues[0]}`, "error");
      return;
    }
    setActiveReport(name);
    setActiveName(name);
    setActiveSpec(spec);
    setReportName(name);
    setReportSpec(spec);
    setReports(listReports());
    setReportPrompt(undefined);
    notify(`已新建报告「${name}」`);
  };

  const deleteReport = (name: string) => {
    removeReport(name);
    setReports(listReports());
    setReportToDelete(undefined);
    if (activeName === name) {
      // The pointer is gone with the file; fall back to the built-in default.
      setActiveReport(undefined);
      setActiveName(undefined);
      setActiveSpec(DEFAULT_REPORT);
      setReportName(DEFAULT_REPORT_NAME);
      setReportSpec(DEFAULT_REPORT);
    } else if (reportName === name) {
      setReportName(DEFAULT_REPORT_NAME);
      setReportSpec(DEFAULT_REPORT);
    }
    notify(`已删除报告「${name}」`);
  };

  /** A name that does not collide with a stored spec or a built-in. */
  const freeReportName = (base = "my-report") => {
    const taken = new Set([...reports.map((report) => report.name), ...Object.keys(BUILT_IN_REPORTS)]);
    if (!taken.has(base)) return base;
    let counter = 2;
    while (taken.has(`${base}-${counter}`)) counter += 1;
    return `${base}-${counter}`;
  };

  /* ── packs ──────────────────────────────────────────────── */

  const openPack = async (name: string | undefined) => {
    // `undefined` means the built-in defaults, not "the active pack": the pack
    // list already shows which pack is active, and picking the defaults has to
    // pick the defaults even when another pack is active.
    const loaded = name === undefined ? DEFAULT_PACK : await store.load(name).catch(() => DEFAULT_PACK);
    setPackName(name);
    setPack(loaded);
    setSelectedRuleId(loaded.rules[0]?.id);
  };

  const createPack = () => {
    setPackPrompt({ kind: "create" });
  };

  /** The name dialog's answer: create a pack, or fork a read-only one. */
  const namePack = async (name: string) => {
    const pending = packPrompt;
    if (!pending) return;
    try {
      if (pending.kind === "apply") {
        // A pasted pack: the name may already exist, and applying then means
        // replacing that file — the dialog says so before you press the button.
        await store.save(name, pending.pack, { force: true });
        await refreshPacks();
        setPackName(name);
        setPack(pending.pack);
        setSelectedRuleId(pending.pack.rules[0]?.id);
        notify(`已应用到「${name}」`);
        setPackPrompt(undefined);
        setPackJsonOpen(false);
        return;
      }
      // Copy what is on screen, not the pristine defaults: a user who dragged a
      // rule before forking should keep the order they just chose.
      const next: RulePack = { ...structuredClone(pack), name };
      await store.save(name, next, { force: true });
      await store.activate(name).catch(() => undefined);
      await refreshPacks();
      setPackName(name);
      setPack(next);
      setSelectedRuleId(next.rules[0]?.id);
      notify(`已新建规则包「${name}」`);
      setPackPrompt(undefined);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const activatePack = async (name: string | undefined) => {
    try {
      if (name === undefined) await store.deactivate();
      else await store.activate(name);
      await refreshPacks();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const deletePack = async (name: string) => {
    try {
      await store.remove(name);
      await refreshPacks();
      if (packName === name) await openPack(undefined);
      notify(`已删除规则包「${name}」`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
    setPackToDelete(undefined);
  };

  /* ── rules ──────────────────────────────────────────────── */

  const addRuleFromTemplate = (templateId: string) => {
    const template = RULE_TEMPLATES.find((candidate) => candidate.id === templateId);
    if (!template) return;
    let id = `user.${template.id}`;
    let counter = 2;
    while (isIdTaken(pack, id)) id = `user.${template.id}-${counter++}`;
    const rule: Rule = { ...template.build(id), description: template.desc };
    setTemplateOpen(false);
    setView("rules");
    // Appending is the one edit that *is* an upsert.
    setSelectedRuleId(rule.id);
    void persist(packName, upsertRule(pack, rule));
  };

  const duplicateRule = (rule: Rule) => {
    let id = `${rule.id}.copy`;
    let counter = 2;
    while (isIdTaken(pack, id)) id = `${rule.id}.copy-${counter++}`;
    const copy = {
      ...structuredClone(rule),
      id,
      name: `${rule.name ?? rule.id} · 副本`,
    };
    setSelectedRuleId(id);
    void persist(packName, upsertRule(pack, copy));
  };

  const deleteRule = (rule: Rule) => {
    const next = removeRule(pack, rule.id);
    setSelectedRuleId(next.rules[0]?.id);
    void persist(packName, next);
  };

  /* ── sessions ───────────────────────────────────────────── */

  const switchDemo = (id: string) => {
    setDemoId(id);
    setRunId(undefined);
    setSelectedEventIndex(undefined);
    setAllEventsMode(false);
    if (id.startsWith("user:")) {
      const session = userSessions.find((candidate) => candidate.id === id);
      setEvents(renumber(session?.events ?? []));
      setMetrics(session?.metrics ?? []);
      return;
    }
    const demo = DEMOS.find((candidate) => candidate.id === id);
    if (!demo) return;
    setEvents(renumber(demo.build()));
    setMetrics(demo.metrics?.() ?? []);
  };

  /** Persist an edit back into the simulated session it belongs to. */
  const handleEventsChange = (next: ChartEvent[]) => {
    setEvents(next);
    if (demoId.startsWith("user:")) {
      const sessions = userSessions.map((session) =>
        session.id === demoId ? { ...session, events: next } : session,
      );
      setUserSessions(sessions);
      saveUserSessions(sessions);
    }
  };

  /** The header ＋ on the runs column: a new run grows from a user message. */
  /**
   * Delete a whole round.
   *
   * A run is a slice of the stream, not a record of its own — removing one
   * removes every event in it, and there is no undo. So it asks first, and it is
   * the one delete in this editor whose damage is counted in events rather than
   * in a file the user wrote.
   */
  const [runToDelete, setRunToDelete] = useState<RunView | undefined>(undefined);
  const deleteRun = (view: RunView) => {
    const from = view.run.fromIndex;
    const to = view.run.toIndex;
    handleEventsChange(renumber(events.filter((_, index) => index < from || index > to)));
    setRunId(undefined);
    setSelectedEventIndex(undefined);
    setRunToDelete(undefined);
    notify(`已删除第 ${view.index + 1} 轮（${view.eventCount} 个事件）`);
  };

  const addRun = () => {
    const last = events[events.length - 1]?.timestamp ?? Date.now() - 1000;
    const opener = newEvent("message", last + 1000, "simulated");
    opener.payload = { role: "user", content: "新的轮次" };
    handleEventsChange(renumber([...events, opener]));
    setRunId(undefined);
    setSelectedEventIndex(undefined);
  };

  /**
   * The header ＋ on the sessions column opens a dialog with two ways to add a
   * session:
   *
   *   empty     a blank stream, built event by event
   *   absence   one **one-shot copy of an Absence session** — the agent really
   *             running in `../daze`, not a conversation in this editor
   *
   * The import is a photograph: the dialog read Absence once, before this call,
   * and hands over the copy. Nothing here re-reads it, so the new session can
   * never drift back into sync with the agent it came from.
   *
   * Resolves to an error message when the copy cannot be kept (Storage full),
   * so the dialog can stay open with its explanation.
   */
  const createSession = async (
    name: string,
    mode: SessionMode,
    imported?: AbsenceImport,
  ): Promise<string | undefined> => {
    const id = `user:s-${Date.now()}`;
    const copiedEvents = mode === "absence" ? (imported?.events ?? []) : ([] as ChartEvent[]);
    const copiedMetrics = mode === "absence" ? (imported?.metrics ?? []) : ([] as MetricsFrameLike[]);
    const session: StoredSession = {
      id,
      name,
      events: copiedEvents,
      ...(mode === "absence" && imported
        ? {
            metrics: copiedMetrics,
            importedFrom: {
              sessionId: imported.sessionId,
              label: imported.label,
              ...(imported.projectPath ? { projectPath: imported.projectPath } : {}),
              fetchedAt: imported.fetchedAt,
              ...(imported.truncated ? { truncated: true } : {}),
            },
          }
        : {}),
    };
    const sessions = [...userSessions, session];
    if (!saveUserSessions(sessions)) {
      return "浏览器存不下这份会话（可能是太大了）——删点旧会话，或换个短一点的会话";
    }
    setUserSessions(sessions);
    setNewSessionOpen(false);
    setDemoId(id);
    setRunId(undefined);
    setSelectedEventIndex(undefined);
    setAllEventsMode(false);
    setEvents(copiedEvents);
    setMetrics(copiedMetrics);
    notify(
      mode === "absence"
        ? `已从 Absence 导入「${name}」：${copiedEvents.length} 个事件${imported?.truncated ? "（太长，只取了最新部分）" : ""}，之后不再同步`
        : `已新建模拟会话「${name}」——去事件流里加第一轮`,
    );
    return undefined;
  };

  const deleteSession = (id: string) => {
    const gone = userSessions.find((session) => session.id === id);
    const sessions = userSessions.filter((session) => session.id !== id);
    setUserSessions(sessions);
    saveUserSessions(sessions);
    setSessionToDelete(undefined);
    if (demoId === id) void switchDemo(DEMOS[0]!.id);
    if (gone) notify(`已删除会话「${gone.name}」`);
  };

  // Selection is positional; see the derivation above.
  const selectedRule = pack.rules[selectedIndex];

  /** The 事件会话 column's rows: the user's sessions, then the demos. */
  const subjects: Subject[] = [
    ...userSessions.map((session) => ({
      id: session.id,
      label: session.name,
      hint: session.importedFrom
        ? `Absence 导入 · 复制自「${session.importedFrom.label}」，之后不再同步`
        : "模拟会话 · 保存在浏览器里，删了就没了",
      deletable: true,
    })),
    ...DEMOS.map((demo) => ({
      id: demo.id,
      label: demo.label,
      hint: demo.description,
    })),
  ];

  const sessionNames = [...userSessions.map((session) => session.name), ...DEMOS.map((demo) => demo.label)];
  /** One 事件会话 column, shared by the report and event views. */
  /**
   * Two versions of the 事件会话 column, and the difference is the point.
   *
   * The event view *manages* sessions — it can create and delete them. The
   * report view only *shows* which one it is reporting on: no ＋, no ✕, because a
   * report that could add a session would be an editor wearing a report's
   * clothes. Selecting a session stays, because that is navigation, not editing.
   */
  const sessionColumn = (
    <SessionColumn
      subjects={subjects}
      selectedId={demoId}
      onSelect={(id) => void switchDemo(id)}
      onAdd={() => setNewSessionOpen(true)}
      onDelete={(id) => setSessionToDelete(id)}
    />
  );
  const sessionColumnReadOnly = (
    <SessionColumn subjects={subjects} selectedId={demoId} onSelect={(id) => void switchDemo(id)} />
  );

  return (
    <div className="shell">
      <div className="topbar">
        <svg className="ecg" width="66" height="20" viewBox="0 0 72 22" aria-hidden="true">
          <path d="M0 14 H12 l3 -3 l3 3 h6 l3 -12 l4 20 l3 -8 h8 l3 -3 l3 3 h21" />
        </svg>
        <span className="brand">CHART</span>
        <span className="brand-sub">Regimen</span>

        <div className="views">
          <button className={view === "report" ? "on" : ""} onClick={() => setView("report")}>
            监护报告
          </button>
          <button className={view === "rules" ? "on" : ""} onClick={() => setView("rules")}>
            规则编辑
          </button>
          <button className={view === "reports" ? "on" : ""} onClick={() => setView("reports")}>
            报告编辑
          </button>
          <button className={view === "events" ? "on" : ""} onClick={() => setView("events")}>
            事件流
          </button>
        </div>

        <span className="spacer" />
      </div>

      {/* ══ 监护报告 ═════════════════════════════════════════ */}
      {/* Kept mounted so the tape keeps its position when you go edit a rule. */}
      <ReportView
        sessionId={demoId}
        active={view === "report"}
        events={events}
        views={views}
        runId={runId ?? selectedView?.run.id}
        pack={pack}
        packs={packs}
        packName={packName}
        metrics={metrics}
        spec={activeSpec}
        sessions={sessionColumnReadOnly}
        onSelectRun={setRunId}
      />

      {/* ══ 规则编辑 ═════════════════════════════════════════ */}
      {view === "rules" ? (
        <div className="view rules">
          <PackColumn
            packs={packs}
            packName={packName}
            onSelect={(name) => void openPack(name)}
            onCreate={() => createPack()}
            onActivate={(name) => void activatePack(name)}
            onDelete={(name) => setPackToDelete(name)}
            onImport={() => packInput.current?.click()}
            onExport={() => packName && downloadPack(packName, serializePack(pack))}
            onShowJson={() => setPackJsonOpen(true)}
          />
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
                notify(`已导入「${name}」`);
              } catch (error) {
                notify(error instanceof Error ? error.message : String(error), "error");
              }
            }}
          />

          <div className="col rules-col">
            <div className="pane-head">
              <span>规则 rules</span>
              <span className="spacer" />
              <span className="tiny">{pack.rules.length}</span>
              <button className="btn tiny" onClick={() => setTemplateOpen(true)} title="从模板新建一条规则">
                ＋新建
              </button>
            </div>
            <div className="pane-body">
              <RuleCardList
                rules={pack.rules}
                selectedId={selectedRule?.id}
                onSelect={setSelectedRuleId}
                onMove={moveRule}
                // No ✕ on a read-only pack: the built-in cannot lose a rule.
                onDelete={
                  packName === undefined
                    ? undefined
                    : (id) => {
                        const rule = pack.rules.find((candidate) => candidate.id === id);
                        if (rule) deleteRule(rule);
                      }
                }
              />
            </div>
          </div>

          {selectedRule ? (
            <RuleEditor
              rule={selectedRule}
              pack={pack}
              events={events}
              runId={selectedView?.run.id}
              runLabel={selectedView ? `第 ${selectedIndex + 1} 轮` : undefined}
              readOnly={packName === undefined}
              onFork={() => createPack()}
              onChange={updateRule}
              onDuplicate={() => duplicateRule(selectedRule)}
              onOpenReport={() => setView("report")}
              onNotify={notify}
            />
          ) : (
            <div className="col rule-main">
              <div className="pane-body">
                <div className="empty">这个规则包还没有规则，点「＋新建」从一个模板开始。</div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* ══ 报告编辑 ═════════════════════════════════════════ */}
      {view === "reports" ? (
        <div className="view reports">
          <div className="col reports-col">
            <div className="pane-head">
              <span>报告 reports</span>
              <span className="spacer" />
              <button
                className="btn tiny"
                onClick={() => setReportPrompt({ kind: "create", from: reportSpec })}
                title="把现在看到的报告复制成一份可编辑的"
              >
                ＋新建
              </button>
            </div>
            <div className="pane-body stack" style={{ gap: 3 }}>
              <ReportRow
                label="原始报告"
                hint="内置的这一份：这一轮做了什么、留下了什么"
                count={CLASSIC_REPORT.sections.length}
                active={activeName === undefined || activeName === DEFAULT_REPORT_NAME}
                selected={reportName === DEFAULT_REPORT_NAME}
                onSelect={() => openReport(DEFAULT_REPORT_NAME)}
                onActivate={() => activateReport(DEFAULT_REPORT_NAME)}
              />
              {reports.map((report) => (
                <ReportRow
                  key={report.name}
                  label={report.name}
                  hint={report.title || report.name}
                  count={report.sections}
                  active={activeName === report.name}
                  selected={reportName === report.name}
                  issues={report.issues.length}
                  onSelect={() => openReport(report.name)}
                  onActivate={() => activateReport(report.name)}
                  onDelete={() => setReportToDelete(report.name)}
                />
              ))}
              {reports.length === 0 ? (
                <div className="zh-hint" style={{ marginTop: 6 }}>
                  还没有自己的报告。「＋新建」会把当前这份复制成一份可编辑的副本。
                </div>
              ) : null}

              <div className="pack-actions">
                <button
                  className="btn tiny"
                  onClick={() => setReportJsonOpen(true)}
                  title="把整份报告作为 JSON 查看 / 复制 / 粘贴导入"
                >
                  {"{ }"} 报告 JSON
                </button>
                <button
                  className="btn tiny"
                  onClick={() => reportInput.current?.click()}
                  title="从文件导入一份报告"
                >
                  导入文件
                </button>
                {reportName && !isBuiltInReport(reportName) ? (
                  <button
                    className="btn tiny"
                    onClick={() => downloadReport(reportName, reportSpec)}
                    title="下载成 JSON 文件"
                  >
                    下载
                  </button>
                ) : null}
              </div>
              <input
                ref={reportInput}
                type="file"
                accept=".json"
                style={{ display: "none" }}
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  try {
                    const spec = parseSpec(await file.text());
                    const issues = validateSpec(spec);
                    if (issues.length > 0) {
                      notify(`这份报告有 ${issues.length} 处问题：${issues[0]?.path} ${issues[0]?.message}`, "error");
                      return;
                    }
                    const name = file.name.replace(/\.json$/i, "");
                    setReportPrompt({ kind: "create", from: spec });
                    notify(`已读取「${name}」，给它一个名字`);
                  } catch (error) {
                    notify(error instanceof Error ? error.message : String(error), "error");
                  }
                }}
              />
            </div>
          </div>

          <ReportEditor
            spec={reportSpec}
            events={events}
            runId={selectedView?.run.id}
            pack={pack}
            readOnly={isBuiltInReport(reportName)}
            onChange={persistReport}
            onOpenReport={() => setView("report")}
            onNotify={notify}
          />
        </div>
      ) : null}

      {/* ══ 事件流 ═══════════════════════════════════════════ */}
      {view === "events" ? (
        <EventStreamEditor
          events={events}
          views={views}
          // The *raw* selection, not `selectedView?.run.id`: that resolves an
          // empty `runId` to the newest round, which would keep a round card lit
          // while 「全部事件」 is the scope actually being shown.
          runId={runId}
          allMode={allEventsMode}
          selectedIndex={selectedEventIndex}
          onChange={handleEventsChange}
          onSelectRun={(id) => {
            // Picking a round and 「全部事件」 are the same choice made two ways:
            // they are mutually exclusive, or both cards would light up and the
            // list would claim to be showing two scopes at once.
            setAllEventsMode(false);
            setRunId(id);
          }}
          onToggleAll={() => {
            // Turning it on clears the round selection; turning it off falls back
            // to the newest round, which is what an empty `runId` means.
            if (!allEventsMode) setRunId(undefined);
            setAllEventsMode(!allEventsMode);
          }}
          onSelectIndex={setSelectedEventIndex}
          onAddRun={addRun}
          onDeleteRun={setRunToDelete}
          sessions={sessionColumn}
        />
      ) : null}

      {/* ══ 模板 ═════════════════════════════════════════════ */}
      {templateOpen ? (
        <div className="modal-veil" onClick={() => setTemplateOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>＋ 新建规则</h2>
            <div className="sub">
              从一个常见场景开始，选完随时可以改。需要「A 而且 B,或者 C」?拆成两条规则就好。
            </div>
            {RULE_TEMPLATES.map((template) => (
              <button className="template" key={template.id} onClick={() => addRuleFromTemplate(template.id)}>
                <span className="ico">▸</span>
                <span>
                  <div className="name">{template.name}</div>
                  <div className="desc">{template.desc}</div>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {reportJsonOpen ? (
        <JsonDialog
          title={
            reportName && !isBuiltInReport(reportName)
              ? `报告「${reportName}」`
              : "内置报告"
          }
          subtitle={`${reportSpec.sections.length} 个区块${
            reportName && !isBuiltInReport(reportName) ? "" : " · 只读，应用会先复制成一份新的报告"
          }`}
          value={reportSpec}
          onClose={() => setReportJsonOpen(false)}
          onCopied={(ok) => notify(ok ? "已复制报告 JSON" : "复制失败，请手动选择文本", ok ? "info" : "error")}
          onApply={(parsed) => {
            const spec = parsed as ReportSpec;
            const issues = validateSpec(spec);
            if (issues.length > 0) {
              notify(`这份报告有 ${issues.length} 处问题，已拒绝应用：${issues[0]?.path}`, "error");
              return;
            }
            if (!reportName || isBuiltInReport(reportName)) {
              setReportPrompt({ kind: "create", from: spec });
              return;
            }
            const saveIssues = saveReport(reportName, spec);
            if (saveIssues.length > 0) {
              notify(`${saveIssues.length} 处问题：${saveIssues[0]}`, "error");
              return;
            }
            setReportSpec(spec);
            setReports(listReports());
            notify(`已应用到「${reportName}」`);
            setReportJsonOpen(false);
          }}
        />
      ) : null}

      {packJsonOpen ? (
        <JsonDialog
          title={packName ? `规则包「${packName}」` : "内置默认规则包"}
          subtitle={`${pack.rules.length} 条规则${packName ? "" : " · 只读，应用会先复制成新的规则包"}`}
          value={pack}
          onClose={() => setPackJsonOpen(false)}
          onCopied={(ok) => notify(ok ? "已复制规则包 JSON" : "复制失败，请手动选择文本", ok ? "info" : "error")}
          actions={
            packName ? (
              <button
                className="btn tiny"
                onClick={() => downloadPack(packName, serializePack(pack))}
                title="下载成 JSON 文件，可以发给别人"
              >
                下载
              </button>
            ) : null
          }
          onApply={async (parsed) => {
            try {
              const next = parsePack(JSON.stringify(parsed));
              const issues = validatePack(next);
              if (issues.length > 0) {
                notify(`规则包有 ${issues.length} 处问题，已拒绝应用`, "error");
                return;
              }
              if (packName === undefined) {
                // Read-only: ask for a name in the editor's own dialog, then
                // fork. `namePack` keeps the parsed pack until you answer.
                setPackPrompt({ kind: "apply", pack: next });
                return;
              }
              await store.save(packName, next, { force: true });
              await refreshPacks();
              setPack(next);
              setSelectedRuleId(next.rules[0]?.id);
              notify(`已应用到「${packName}」`);
              setPackJsonOpen(false);
            } catch (error) {
              notify(error instanceof Error ? error.message : String(error), "error");
            }
          }}
        />
      ) : null}

      {packPrompt ? (
        <PromptDialog
          title={packPrompt.kind === "create" ? "＋ 新建规则包" : "应用到新的规则包"}
          subtitle={
            packPrompt.kind === "create"
              ? "会把你现在看到的规则（包括刚才拖出来的顺序）复制成一份可编辑的规则包，并设为生效。"
              : "这份规则包是只读的，先给它一个名字，会新建一份并应用。"
          }
          label="规则包名字"
          placeholder="work"
          initialValue={freePackName(packs.map((summary) => summary.name))}
          validate={(value) =>
            packNameProblem(value, packs.map((summary) => summary.name), packPrompt.kind === "apply")
          }
          hint={
            packPrompt.kind === "create"
              ? "不能和已有的规则包重名。"
              : "重名会覆盖同名文件；想保留旧的，就换个名字。"
          }
          confirmText={packPrompt.kind === "create" ? "新建" : "新建并应用"}
          onConfirm={(name) => namePack(name)}
          onClose={() => setPackPrompt(undefined)}
        />
      ) : null}

      {packToDelete ? (
        <ConfirmDialog
          title="删除规则包"
          message={`确定删除规则包「${packToDelete}」吗？它的规则会一起删掉，不能撤销。`}
          detail={
            packToDelete === packs.find((summary) => summary.active)?.name
              ? "它正在生效，删掉后回到内置默认规则包。"
              : "内置默认规则包不受影响。"
          }
          onConfirm={() => deletePack(packToDelete)}
          onClose={() => setPackToDelete(undefined)}
        />
      ) : null}

      {newSessionOpen ? (
        <NewSessionDialog
          taken={sessionNames}
          defaults={{
            empty: freeSessionName(sessionNames, "我的实验"),
            absence: freeSessionName(sessionNames, "Absence 会话"),
          }}
          onCreate={createSession}
          onClose={() => setNewSessionOpen(false)}
        />
      ) : null}

      {sessionToDelete ? (
        <ConfirmDialog
          title="删除会话"
          message={`确定删除会话「${userSessions.find((session) => session.id === sessionToDelete)?.name}」吗？它的整段事件流会一起删掉，不能撤销。`}
          detail="内置演示会话不受影响；从 Absence 导入的副本已经独立，删了也不会影响 Absence。"
          onConfirm={() => deleteSession(sessionToDelete)}
          onClose={() => setSessionToDelete(undefined)}
        />
      ) : null}

      {reportPrompt ? (
        <PromptDialog
          title="＋ 新建报告"
          subtitle="会把你现在看到的区块（包括顺序）复制成一份可编辑的报告，并设为生效。"
          label="报告名字"
          placeholder="my-report"
          initialValue={freeReportName()}
          validate={(value) => {
            if (value === "") return "名字不能为空";
            if (!PACK_NAME_RE.test(value)) return "只能用字母、数字、. - _，最多 64 个字符";
            if (reports.some((report) => report.name === value)) return `已经有名为「${value}」的报告了`;
            return undefined;
          }}
          hint="不能和已有的报告重名。内置报告不会被改动。"
          confirmText="新建"
          onConfirm={(name) => createReport(name, reportPrompt.from)}
          onClose={() => setReportPrompt(undefined)}
        />
      ) : null}

      {reportToDelete ? (
        <ConfirmDialog
          title="删除报告"
          message={`确定删除报告「${reportToDelete}」吗？它的区块会一起删掉，不能撤销。`}
          detail="内置报告不受影响；删掉正在生效的那份会回到内置报告。"
          onConfirm={() => deleteReport(reportToDelete)}
          onClose={() => setReportToDelete(undefined)}
        />
      ) : null}

      {runToDelete ? (
        <ConfirmDialog
          title="删除这一轮"
          message={`确定删除第 ${runToDelete.index + 1} 轮吗？它的 ${runToDelete.eventCount} 个事件会一起删掉，不能撤销。`}
          detail="轮次就是一段事件流 —— 删掉它等于删掉那一段。其他轮次不受影响。"
          onConfirm={() => deleteRun(runToDelete)}
          onClose={() => setRunToDelete(undefined)}
        />
      ) : null}

      {toast ? <div className={`toast ${toast.tone}`}>{toast.text}</div> : null}
    </div>
  );
}
