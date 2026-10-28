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
  EXAMPLE_PACK,
  PACK_NAME_RE,
  PackStore,
  isIdTaken,
  parsePack,
  removeRule,
  serializePack,
  upsertRule,
  validatePack,
  type ChartEvent,
  type PackSummary,
  type Rule,
  type RulePack,
} from "../../src/index.ts";
import { adaptivePackIO, backendKind, downloadPack, loadUserSessions, saveUserSessions, type StoredSession, type Backend } from "./lib/storage.ts";
import type { MetricsFrameLike } from "../../src/core/live.ts";
import { DEMOS } from "./lib/demo.ts";
import { newEvent, renumber } from "./lib/events.ts";
import { pickRunView, runViews } from "./lib/runs.ts";
import { RULE_TEMPLATES } from "./lib/plain.ts";
import { EXAMPLE_PACK_NAME, PackColumn } from "./components/PackColumn.tsx";
import { SessionColumn, type Subject } from "./components/SessionColumn.tsx";
import { NewSessionDialog, type SessionMode } from "./components/NewSessionDialog.tsx";
import { ConfirmDialog, PromptDialog } from "./components/PromptDialog.tsx";
import { JsonDialog } from "./components/JsonDialog.tsx";
import { RuleCardList } from "./components/RuleCardList.tsx";
import { RuleEditor } from "./components/RuleEditor.tsx";
import { ReportView } from "./components/ReportView.tsx";
import { EventStreamEditor } from "./components/EventStreamEditor.tsx";

const store = new PackStore(adaptivePackIO(), DEFAULT_PACK);

type View = "report" | "rules" | "events";

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
  if (name === EXAMPLE_PACK_NAME) return `「${EXAMPLE_PACK_NAME}」是只读示例包的名字，换一个`;
  if (!allowExisting && taken.includes(name)) return `已经有名为「${name}」的规则包了`;
  return undefined;
}

export function App() {
  const [view, setView] = useState<View>("report");
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [packName, setPackName] = useState<string | undefined>(undefined);
  const [pack, setPack] = useState<RulePack>(DEFAULT_PACK);
  const [selectedRuleId, setSelectedRuleId] = useState<string | undefined>(undefined);

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

  const persist = useCallback(
    async (name: string | undefined, next: RulePack) => {
      setPack(next);
      // The built-in defaults and the example pack are not files: an edit has to
      // fork into a real pack first, and the editor says so.
      if (!name || name === EXAMPLE_PACK_NAME) return;
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
      setSelectedRuleId(rule.id);
      void persist(packName, upsertRule(pack, rule));
    },
    [pack, packName, persist],
  );

  const moveRule = useCallback(
    (from: number, to: number) => {
      const rules = [...pack.rules];
      const [moved] = rules.splice(from, 1);
      if (!moved) return;
      rules.splice(to, 0, moved);
      void persist(packName, { ...pack, rules });
    },
    [pack, packName, persist],
  );

  /* ── packs ──────────────────────────────────────────────── */

  const openPack = async (name: string | undefined) => {
    // `undefined` means the built-in defaults, not "the active pack": the pack
    // list already shows which pack is active, and picking the defaults has to
    // pick the defaults even when another pack is active.
    const loaded =
      name === undefined
        ? DEFAULT_PACK
        : name === EXAMPLE_PACK_NAME
          ? structuredClone(EXAMPLE_PACK)
          : await store.load(name).catch(() => DEFAULT_PACK);
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
    updateRule(rule);
    setTemplateOpen(false);
    setView("rules");
  };

  const duplicateRule = (rule: Rule) => {
    let id = `${rule.id}.copy`;
    let counter = 2;
    while (isIdTaken(pack, id)) id = `${rule.id}.copy-${counter++}`;
    updateRule({
      ...structuredClone(rule),
      id,
      name: `${rule.name ?? rule.id} · 副本`,
    });
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
   * session. Both set state directly rather than through `switchDemo`, whose
   * closure still sees the session list from before this one was added.
   *
   * `snapshot` is the interesting one: the current session's events (and its
   * resource samples) are **deep-copied once**, at the click. From then on the
   * copy and the source are two independent sessions — no live link, no sync.
   */
  const createSession = (name: string, mode: SessionMode) => {
    const id = `user:s-${Date.now()}`;
    // The snapshot is taken here and nowhere else: this is the "one click" the
    // option promises. Nothing downstream re-reads the source session.
    const copiedEvents = mode === "snapshot" ? structuredClone(events) : ([] as ChartEvent[]);
    const copiedMetrics = mode === "snapshot" ? structuredClone(metrics) : ([] as MetricsFrameLike[]);
    const session: StoredSession = {
      id,
      name,
      events: copiedEvents,
      ...(mode === "snapshot"
        ? { metrics: copiedMetrics, snapshotOf: { id: demoId, label: currentSubjectLabel } }
        : {}),
    };
    const sessions = [...userSessions, session];
    setUserSessions(sessions);
    saveUserSessions(sessions);
    setNewSessionOpen(false);
    setDemoId(id);
    setRunId(undefined);
    setSelectedEventIndex(undefined);
    setAllEventsMode(false);
    setEvents(copiedEvents);
    setMetrics(copiedMetrics);
    notify(
      mode === "snapshot"
        ? `已快照「${name}」：${copiedEvents.length} 个事件，之后不再同步`
        : `已新建模拟会话「${name}」——去事件流里加第一轮`,
    );
  };

  const deleteSession = (id: string) => {
    const gone = userSessions.find((session) => session.id === id);
    const sessions = userSessions.filter((session) => session.id !== id);
    setUserSessions(sessions);
    saveUserSessions(sessions);
    setSessionToDelete(undefined);
    if (demoId === id) void switchDemo(DEMOS[0]!.id);
    if (gone) notify(`已删除模拟会话「${gone.name}」`);
  };

  const selectedRule = pack.rules.find((rule) => rule.id === selectedRuleId) ?? pack.rules[0];

  /** The label of the session currently on screen, for the snapshot option. */
  const currentSubjectLabel =
    userSessions.find((session) => session.id === demoId)?.name ??
    DEMOS.find((demo) => demo.id === demoId)?.label ??
    "当前会话";

  /** The 事件会话 column's rows: the user's simulated sessions, then the demos. */
  const subjects: Subject[] = [
    ...userSessions.map((session) => ({
      id: session.id,
      label: session.name,
      hint: session.snapshotOf
        ? `快照 · 复制自「${session.snapshotOf.label}」，之后不再同步`
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
  const sessionColumn = (
    <SessionColumn
      subjects={subjects}
      selectedId={demoId}
      onSelect={(id) => void switchDemo(id)}
      onAdd={() => setNewSessionOpen(true)}
      onDelete={(id) => setSessionToDelete(id)}
    />
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
        sessions={sessionColumn}
        onSelectRun={setRunId}
        onSelectPack={(name) => void openPack(name)}
        onActivatePack={(name) => void activatePack(name)}
        onCreatePack={() => void createPack()}
        onSelectRule={(id) => {
          setSelectedRuleId(id);
          setView("rules");
        }}
        onOpenEvents={() => setView("events")}
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
              />
            </div>
          </div>

          {selectedRule ? (
            <RuleEditor
              key={selectedRule.id}
              rule={selectedRule}
              pack={pack}
              readOnly={packName === undefined || packName === EXAMPLE_PACK_NAME}
              onFork={() => createPack()}
              onChange={updateRule}
              onDelete={() => deleteRule(selectedRule)}
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

      {/* ══ 事件流 ═══════════════════════════════════════════ */}
      {view === "events" ? (
        <EventStreamEditor
          events={events}
          views={views}
          runId={selectedView?.run.id}
          allMode={allEventsMode}
          selectedIndex={selectedEventIndex}
          onChange={handleEventsChange}
          onSelectRun={setRunId}
          onToggleAll={() => setAllEventsMode((current) => !current)}
          onSelectIndex={setSelectedEventIndex}
          onAddRun={addRun}
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

      {packJsonOpen ? (
        <JsonDialog
          title={
            packName === EXAMPLE_PACK_NAME
              ? "示例规则包"
              : packName
                ? `规则包「${packName}」`
                : "内置默认规则包"
          }
          subtitle={`${pack.rules.length} 条规则${packName === EXAMPLE_PACK_NAME ? " · 只读示例，应用会先复制成新的规则包" : packName ? "" : " · 只读，应用会先复制成新的规则包"}`}
          value={pack}
          onClose={() => setPackJsonOpen(false)}
          onCopied={(ok) => notify(ok ? "已复制规则包 JSON" : "复制失败，请手动选择文本", ok ? "info" : "error")}
          actions={
            packName && packName !== EXAMPLE_PACK_NAME ? (
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
              if (packName === undefined || packName === EXAMPLE_PACK_NAME) {
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
              : "内置默认和示例规则包不受影响。"
          }
          onConfirm={() => deletePack(packToDelete)}
          onClose={() => setPackToDelete(undefined)}
        />
      ) : null}

      {newSessionOpen ? (
        <NewSessionDialog
          sourceLabel={currentSubjectLabel}
          sourceCount={events.length}
          taken={sessionNames}
          defaults={{
            empty: freeSessionName(sessionNames, "我的实验"),
            snapshot: freeSessionName(sessionNames, `${currentSubjectLabel} · 快照`),
          }}
          onCreate={createSession}
          onClose={() => setNewSessionOpen(false)}
        />
      ) : null}

      {sessionToDelete ? (
        <ConfirmDialog
          title="删除模拟会话"
          message={`确定删除模拟会话「${userSessions.find((session) => session.id === sessionToDelete)?.name}」吗？它的整段事件流会一起删掉，不能撤销。`}
          detail="内置演示会话不受影响。"
          onConfirm={() => deleteSession(sessionToDelete)}
          onClose={() => setSessionToDelete(undefined)}
        />
      ) : null}

      {toast ? <div className={`toast ${toast.tone}`}>{toast.text}</div> : null}
    </div>
  );
}
