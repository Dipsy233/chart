/**
 * The report view: runs | events | the report | the pack.
 *
 * The report is a *playback*, not a static document. Each frame reveals one more
 * event, judges the revealed prefix, and re-renders the report — so a verdict is
 * watched into existence instead of appearing fully formed. Play, pause, step,
 * scrub, and change the speed; the document follows.
 *
 * Judgement lives here and nowhere else. The left two columns are the record, the
 * right column is the pack that is judging it, and the middle column is the
 * answer.
 *
 * The prefix is judged the way a live observer would judge it (live rules, anchor
 * at "now", i.e. the next event's timestamp). The final frame is judged as a
 * settled run. That is why a `settled` rule only speaks at the end — and why the
 * right column labels those rules 待判读 instead of pretending they are quiet.
 */

import { useEffect, useMemo, useState } from "react";
import type { ChartEvent } from "../../../src/core/events.ts";
import { metricsAt } from "../../../src/core/live.ts";
import type { MetricsFrameLike } from "../../../src/core/live.ts";
import { DEFAULT_PACK } from "../../../src/regimen/defaults.ts";
import type { RulePack } from "../../../src/regimen/rule.ts";
import type { PackSummary } from "../../../src/store/packStore.ts";
import { observeRun, report, phaseOf } from "../../../src/index.ts";
import { frameAt, pickRunView, zhRunStatus, type RunView } from "../lib/runs.ts";
import { CLASSIC_REPORT } from "../../../src/report/classic.ts";
import type { ReportSpec } from "../../../src/report/spec.ts";
import { eventSummary } from "../lib/events.ts";
import { zhEventLabel, zhLevel } from "../lib/plain.ts";
import { EventCardList } from "./EventCardList.tsx";
import { ReportDocument } from "./ReportDocument.tsx";
import { RunList } from "./RunList.tsx";

const SPEEDS = [0.5, 1, 2, 4] as const;

export function ReportView({
  sessionId,
  active,
  events,
  views,
  runId,
  pack,
  packs,
  packName,
  metrics,
  spec,
  onSelectRun,
  onSelectPack,
  onActivatePack,
  onCreatePack,
  onSelectRule,
  onOpenEvents,
  /** The 事件会话 column — what is being observed, rendered leftmost. */
  sessions,
}: {
  sessionId: string;
  /** Whether this view is on screen; the tape pauses while it is not. */
  active: boolean;
  events: ChartEvent[];
  views: RunView[];
  runId: string | undefined;
  pack: RulePack;
  packs: PackSummary[];
  packName: string | undefined;
  /** The report spec to render. Defaults to the shipped one. */
  spec?: ReportSpec;
  /** The session's resource samples, if the host has a sampler. */
  metrics?: readonly MetricsFrameLike[];
  onSelectRun: (id: string) => void;
  onSelectPack: (name: string | undefined) => void;
  onActivatePack: (name: string | undefined) => void;
  onCreatePack: () => void;
  onSelectRule: (id: string) => void;
  onOpenEvents: () => void;
  sessions?: React.ReactNode;
}) {
  const view = pickRunView(views, runId);
  const total = view?.eventCount ?? 0;
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);

  // A different round (or a different session) starts the tape over.
  useEffect(() => {
    setCursor(0);
    setPlaying(false);
  }, [sessionId, view?.run.id]);

  // An edit can shorten the run under the cursor.
  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, total - 1)));
  }, [total]);

  useEffect(() => {
    if (!playing || !active || total === 0) return;
    if (cursor >= total - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setCursor((current) => Math.min(current + 1, total - 1));
    }, 1000 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, active, cursor, speed, total]);

  const playback = useMemo(() => {
    if (!view) return undefined;
    const frame = frameAt(events, view, cursor);
    const observation = observeRun(events, frame.run, {
      pack,
      anchor: frame.anchor,
      phase: frame.atEnd ? "settled" : "live",
      // The snapshot is of the frame's moment, so scrubbing backwards shows the
      // resources of that moment — not the newest sample of the session.
      live: { nowMs: frame.anchor, metrics: metrics ? metricsAt(metrics, frame.anchor) : undefined },
    });
    const rendered = report(observation, spec ?? CLASSIC_REPORT, { nowMs: frame.anchor });
    return { frame, observation, rendered };
  }, [events, view, cursor, pack, metrics, spec]);

  const seekTo = (globalIndex: number) => {
    if (!view) return;
    setPlaying(false);
    setCursor(Math.max(0, Math.min(globalIndex - view.run.fromIndex, total - 1)));
  };

  const activeName = packs.find((summary) => summary.active)?.name;

  return (
    <div className={`view report-view${active ? "" : " hidden"}`}>
      {sessions}
      <RunList views={views} events={events} selectedId={view?.run.id} onSelect={onSelectRun} />

      <EventCardList
        events={events}
        indices={view ? indicesOf(view) : []}
        cursorIndex={playback?.frame.index}
        revealedUpTo={playback?.frame.index}
        onSelect={seekTo}
        header={
          <div className="pane-head">
            <span>事件 events</span>
            <span className="spacer" />
            {playback ? (
              <span className="tiny muted">
                {playback.frame.cursor + 1} / {playback.frame.total}
              </span>
            ) : null}
            <button className="btn tiny ghost" title="去事件面板编辑这一轮" onClick={onOpenEvents}>
              ✎
            </button>
          </div>
        }
      />

      {/* ── the report, with the tape controls ───────────────── */}
      <div className="col report-col">
        {playback && view ? (
          <>
            <div className="playbar">
              <div className="play-row">
                <button className="btn tiny ghost" title="回到开头" onClick={() => setCursor(0)}>
                  ⏮
                </button>
                <button
                  className="btn tiny ghost"
                  title="上一个事件"
                  onClick={() => {
                    setPlaying(false);
                    setCursor((current) => Math.max(0, current - 1));
                  }}
                >
                  ◀
                </button>
                <button
                  className={`btn play${playing ? " on" : ""}`}
                  onClick={() => {
                    if (cursor >= total - 1) setCursor(0);
                    setPlaying((current) => !current);
                  }}
                  title={playing ? "暂停" : "从头播放这一轮"}
                >
                  {playing ? "⏸ 暂停" : "▶ 播放"}
                </button>
                <button
                  className="btn tiny ghost"
                  title="下一个事件"
                  onClick={() => {
                    setPlaying(false);
                    setCursor((current) => Math.min(total - 1, current + 1));
                  }}
                >
                  ▶
                </button>
                <button
                  className="btn tiny ghost"
                  title="跳到这一轮的结尾"
                  onClick={() => {
                    setPlaying(false);
                    setCursor(Math.max(0, total - 1));
                  }}
                >
                  ⏭
                </button>

                <div className="segmented speed">
                  {SPEEDS.map((value) => (
                    <button
                      key={value}
                      className={speed === value ? "on" : ""}
                      onClick={() => setSpeed(value)}
                      title={`${value} 倍速`}
                    >
                      {value}×
                    </button>
                  ))}
                </div>

                <span className="spacer" />
                <span className={`chip ${playback.frame.atEnd ? "settled" : "live"}`}>
                  {playback.frame.atEnd ? zhRunStatus(view.run.status) : "进行中"}
                </span>
                <button className="btn tiny ghost" onClick={onOpenEvents} title="去事件面板编辑这一轮">
                  编辑事件流
                </button>
              </div>

              <div className="play-row">
                <input
                  className="scrub"
                  type="range"
                  min={0}
                  max={Math.max(0, total - 1)}
                  value={playback.frame.cursor}
                  onChange={(event) => {
                    setPlaying(false);
                    setCursor(Number(event.target.value));
                  }}
                />
                <span className="tiny mono muted">
                  事件 {playback.frame.cursor + 1}/{total}
                </span>
              </div>

              <div className="play-now">
                <span className="now-no">#{playback.frame.cursor + 1}</span>
                <span className="now-type">{zhEventLabel(events[playback.frame.index]?.type ?? "command")}</span>
                <span className="now-summary">{events[playback.frame.index] ? eventSummary(events[playback.frame.index]!) : ""}</span>
                <span className="spacer" />
                <span className={`chip ${playback.frame.atEnd ? "settled" : "live"}`}>
                  {playback.frame.atEnd ? "本轮已结束" : "进行中"}
                </span>
              </div>
            </div>

            <div className="report-scroll">
              <ReportDocument report={playback.rendered} />
            </div>
          </>
        ) : (
          <div className="pane-body">
            <div className="empty">这段事件流里还没有一轮运行。去「事件流」里加一个 agent_start 或一条用户消息。</div>
          </div>
        )}
      </div>

      {/* ── the lens: pack + what it says right now ─────────── */}
      <div className="col fired-col">
        <div className="pane-head">
          <span>规则包 lens</span>
          <span className="spacer" />
          <span className="tiny">{pack.rules.length} 条</span>
        </div>
        <div className="pane-body stack" style={{ gap: 8 }}>
          <select
            className="field"
            value={packName ?? ""}
            onChange={(event) => onSelectPack(event.target.value || undefined)}
          >
            <option value="">内置默认 · {DEFAULT_PACK.rules.length} 条</option>
            {packs.map((summary) => (
              <option key={summary.name} value={summary.name}>
                {summary.name} · {summary.rules} 条{summary.active ? " · 生效中" : ""}
              </option>
            ))}
          </select>
          <div className="row">
            <button className="btn tiny" onClick={onCreatePack}>
              ＋新建
            </button>
            <button
              className="btn tiny"
              onClick={() => onActivatePack(packName)}
              title={activeName === packName ? "已经是生效规则包" : "把这份规则包设为生效"}
            >
              {activeName === packName ? "✓ 已生效" : "设为生效"}
            </button>
            <span className="spacer" />
            <span className="tiny muted">
              {packName === undefined ? "只读" : "已保存"}
            </span>
          </div>

          {playback ? (
            <>
              <div className="fired-head">
                <span>本轮触发</span>
                <span className="spacer" />
                <span className={`chip ${playback.observation.attention.level}`}>
                  {zhLevel(playback.observation.attention.level)}
                </span>
              </div>

              {playback.observation.findings.length === 0 ? (
                <div className="empty tiny">
                  {playback.frame.atEnd ? "这一轮没有任何规则触发。" : "到目前为止没有规则触发。"}
                </div>
              ) : (
                <div className="stack" style={{ gap: 6 }}>
                  {playback.observation.findings.map((finding) => (
                    <button
                      key={finding.ruleId}
                      className={`fired-item ${finding.level}`}
                      onClick={() => onSelectRule(finding.ruleId)}
                      title="打开这条规则的编辑器"
                    >
                      <span className={`chip ${finding.level}`}>{zhLevel(finding.level)}</span>
                      <span className="fired-title">{finding.title}</span>
                      <span className="fired-rule mono">{finding.ruleId}</span>
                    </button>
                  ))}
                </div>
              )}

              {playback.observation.errors.length > 0 ? (
                <div className="stack" style={{ gap: 3 }}>
                  <div className="fired-head" style={{ color: "var(--high)" }}>
                    <span>{playback.observation.errors.length} 条规则出错</span>
                  </div>
                  {playback.observation.errors.map((error, index) => (
                    <div className="issue" key={index}>
                      <span className="path mono">{error.ruleId}</span>
                      <span>{error.message}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="fired-head" style={{ marginTop: 4 }}>
                <span>规则状态</span>
                <span className="spacer" />
                <span className="tiny muted">点一条去编辑</span>
              </div>
              <div className="rule-state-list">
                {pack.rules.map((rule) => {
                  const finding = playback.observation.findings.find((candidate) => candidate.ruleId === rule.id);
                  const off = rule.enabled === false || rule.emit.level === "none";
                  // Read the phase off the CONDITIONS, the way the engine does.
                  // This used to read `rule.phase`, a field the default pack does
                  // not set, so every rule looked `both` and a settled rule said
                  // 「未触发」 while the tape was still running — the opposite of
                  // the one thing this column exists to say.
                  const phase = phaseOf(rule);
                  const pending = !playback.frame.atEnd && phase === "settled";
                  const notJudged = playback.frame.atEnd && phase === "live";
                  const status = off
                    ? { tone: "off", text: "关闭" }
                    : finding
                      ? { tone: finding.level, text: zhLevel(finding.level) }
                      : pending
                        ? { tone: "pending", text: "待判读" }
                        : notJudged
                          ? { tone: "off", text: "只在进行中" }
                          : { tone: "quiet", text: "未触发" };
                  return (
                    <button
                      key={rule.id}
                      className={`rule-state${finding ? " fired" : ""}${off ? " off" : ""}`}
                      onClick={() => onSelectRule(rule.id)}
                      title={rule.id}
                    >
                      <span className={`state-dot ${status.tone}`} />
                      <span className="state-name">{rule.name || rule.id}</span>
                      <span className={`state-text ${status.tone}`}>{status.text}</span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function indicesOf(view: RunView): number[] {
  const out: number[] = [];
  for (let index = view.run.fromIndex; index <= view.run.toIndex; index++) out.push(index);
  return out;
}
