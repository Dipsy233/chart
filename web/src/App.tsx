/**
 * The shell: a top bar, three views, and one shared state.
 *
 *   监护报告   runs | events | the report (playback) | the pack
 *   规则编辑   packs | rules (drag to reorder) | the rule
 *   事件流     runs | events | the event
 *
 * The top bar does exactly two things: switch views, and pick the 监护对象 (the
 * session being observed). Everything else — phase, anchor, demo labels, notices
 * — is gone: a control that only exists to explain the old editor is a control
 * the new one should not have.
 *
 * The shared state is the session's events, the selected pack, and the selected
 * run. Judgement happens only in the report view; the other two views edit data.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PACK,
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
import { adaptivePackIO, backendKind, downloadPack, type Backend } from "./lib/storage.ts";
import { DEMOS } from "./lib/demo.ts";
import { renumber } from "./lib/events.ts";
import { pickRunView, runViews } from "./lib/runs.ts";
import { RULE_TEMPLATES } from "./lib/plain.ts";
import { PackColumn } from "./components/PackColumn.tsx";
import { JsonDialog } from "./components/JsonDialog.tsx";
import { RuleCardList } from "./components/RuleCardList.tsx";
import { RuleEditor } from "./components/RuleEditor.tsx";
import { ReportView } from "./components/ReportView.tsx";
import { EventStreamEditor } from "./components/EventStreamEditor.tsx";

const store = new PackStore(adaptivePackIO(), DEFAULT_PACK);

type View = "report" | "rules" | "events";

export function App() {
  const [view, setView] = useState<View>("report");
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [packName, setPackName] = useState<string | undefined>(undefined);
  const [pack, setPack] = useState<RulePack>(DEFAULT_PACK);
  const [selectedRuleId, setSelectedRuleId] = useState<string | undefined>(undefined);

  const [demoId, setDemoId] = useState(DEMOS[0]!.id);
  const [events, setEvents] = useState<ChartEvent[]>(() => renumber(DEMOS[0]!.build()));
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [selectedEventIndex, setSelectedEventIndex] = useState<number | undefined>(undefined);
  const [allEventsMode, setAllEventsMode] = useState(false);

  const [templateOpen, setTemplateOpen] = useState(false);
  const [packJsonOpen, setPackJsonOpen] = useState(false);
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
      if (!name) return; // the built-in defaults are read-only
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
    const loaded = name === undefined ? DEFAULT_PACK : await store.load(name).catch(() => DEFAULT_PACK);
    setPackName(name);
    setPack(loaded);
    setSelectedRuleId(loaded.rules[0]?.id);
  };

  const createPack = async () => {
    const name = window.prompt("新规则包的名字(字母、数字、. - _)", "work");
    if (!name) return;
    try {
      // Copy what is on screen, not the pristine defaults: a user who dragged a
      // rule before forking should keep the order they just chose.
      const next: RulePack = { ...structuredClone(pack), name };
      await store.save(name, next, { force: true });
      await store.activate(name).catch(() => undefined);
      await refreshPacks();
      setPackName(name);
      setPack(next);
      setSelectedRuleId(next.rules[0]?.id);
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
    if (!window.confirm(`确定删除规则包「${name}」吗？`)) return;
    await store.remove(name);
    await refreshPacks();
    if (packName === name) await openPack(undefined);
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
    const demo = DEMOS.find((candidate) => candidate.id === id);
    if (!demo) return;
    setDemoId(demo.id);
    setEvents(renumber(demo.build()));
    setRunId(undefined);
    setSelectedEventIndex(undefined);
    setAllEventsMode(false);
  };

  const selectedRule = pack.rules.find((rule) => rule.id === selectedRuleId) ?? pack.rules[0];

  /* ── render ─────────────────────────────────────────────── */

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

        <span className={`backend ${backend ?? "local"}`} title={backend === "api" ? "规则包存在磁盘上，和 API/agent 共享" : "规则包存在浏览器 localStorage 里；启动 npm run api 可与磁盘共享"}>
          {backend === "api" ? "磁盘 · API" : "浏览器"}
        </span>

        <span className="label">监护对象</span>
        <select
          className="field subject"
          value={demoId}
          onChange={(event) => switchDemo(event.target.value)}
          title={DEMOS.find((demo) => demo.id === demoId)?.description}
        >
          {DEMOS.map((demo) => (
            <option key={demo.id} value={demo.id}>
              {demo.label}
            </option>
          ))}
        </select>
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
            onCreate={() => void createPack()}
            onActivate={(name) => void activatePack(name)}
            onDelete={(name) => void deletePack(name)}
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
              readOnly={packName === undefined}
              onFork={() => void createPack()}
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
          onChange={setEvents}
          onSelectRun={setRunId}
          onToggleAll={() => setAllEventsMode((current) => !current)}
          onSelectIndex={setSelectedEventIndex}
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
                const name = window.prompt(
                  "这是内置默认规则包（只读）。要应用到哪个规则包?输入一个新名字会新建一份。",
                  "work",
                );
                if (!name) return;
                await store.save(name, next, { force: true });
                await refreshPacks();
                setPackName(name);
                setPack(next);
                setSelectedRuleId(next.rules[0]?.id);
                notify(`已新建并应用「${name}」`);
              } else {
                await store.save(packName, next, { force: true });
                await refreshPacks();
                setPack(next);
                setSelectedRuleId(next.rules[0]?.id);
                notify(`已应用到「${packName}」`);
              }
              setPackJsonOpen(false);
            } catch (error) {
              notify(error instanceof Error ? error.message : String(error), "error");
            }
          }}
        />
      ) : null}

      {toast ? <div className={`toast ${toast.tone}`}>{toast.text}</div> : null}
    </div>
  );
}
