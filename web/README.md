# Chart · Regimen editor (web)

A rule editor, a run report you can *play*, and an event-stream editor — in the
browser. It imports `../src` directly: no build step between the engine and the UI
that shows it.

```bash
npm install
npm run dev      # http://localhost:5174
```

## One rule: judgement lives in the report

The editor, the event stream, and the pack list all edit **data**. Only the report
panel runs the pack. That is the split the whole UI is built around:

- editing a rule never shows a verdict next to the form;
- editing an event never shows a finding next to the event;
- the report panel is the one place a judgement appears, and it says which pack
  produced it.

So the feedback loop is a deliberate two-step: change something, then look at the
report. The report is a playback, so looking is cheap.

## Four views, one state

The top bar switches views. What is being observed — the **监护对象** — is the
事件会话 column of the report and event views, where every session is visible at
once.

Everything else — the session's events, the selected pack, the selected run, the
selected report spec — is shared, so the rule you edit is the rule the report
judges with, and the spec you edit is the spec the report renders.

### 监护报告 — runs | events | the report | the pack

```
┌ runs ──────┬ events ───────────┬ the report ──────────────────┬ the lens ─────┐
│ 第 1 轮    │ 02 消息    +5s    │ ⏮ ◀ ▶播放 ▶ ⏭   1× 2× 4×    │ pack [work ▾] │
│ 已完成     │ 03 思考   +10s    │ 事件 7/14 ──────●──────────  │ 本轮触发      │
│ run_1 · …  │ 04 搜索   +15s    │ ── 运行报告 · run_1 ──      │ 严重 4 个失败 │
│ 第 2 轮    │ 05 读文件 +20s    │ 严重  失败                  │ 警告 连续失败 │
│ …          │ 06 命令   +25s    │ 触发结果 …                  │ 规则状态 …    │
└────────────┴───────────────────┴─────────────────────────────┴───────────────┘
```

The report is a **tape**, not a static document. Each frame reveals one more
event, judges the revealed prefix, and re-renders:

- **play / pause**, **step**, **scrub**, **0.5× / 1× / 2× / 4×**;
- clicking an event card seeks to it; cards after the cursor are dimmed;
- the prefix is judged the way a live observer would (live rules, anchor at the
  next event), and the final frame is judged as a settled run. That is why a
  `settled` rule only speaks at the end — the right column labels those rules
  **待判读** instead of pretending they are quiet.

The right column is the lens: which pack is judging, what it fired right now, and
the state of every rule in the pack (已触发 / 待判读 / 未触发 / 关闭).

The report spec itself is `src/lib/reports.ts` — an ordinary `ReportSpec`, in
Chinese, with the same sections and sources the engine ships. A custom spec is a
data edit, not a renderer edit.

### 规则编辑 — packs | rules | the rule (form + JSON)

```
┌ packs ────┬ rules ─────────────────┬ 1 信息 ─────────────┬ 原生 JSON ──────┐
│ ●内置默认 │ ⠿ 代理带着错误停止     │ 名称 / 描述 / 标签   │ {                │
│ ○示例规则 │ ⠿ 未恢复的失败         │ 优先级 / 判读时机     │   "id": "run.…", │
│ ○work     │ ⠿ 连续失败             │ 2 规则               │   "when": { … }, │
│ ＋新建     │ ⠿ 进程没收尾           │ 人话版 / 条件 / 预设  │   "when": { … }  │
│ { } 规则包 │ …                      │ 3 报告               │ }                │
│ 导入 下载 │                        │ 级别 / 标题 / 证据    │ [放大]           │
└───────────┴────────────────────────┴──────────────────────┴──────────────────┘
```

**The dot before a pack name is the switch.** Click it and that pack becomes
**生效** (filled green); click the rest of the row and you open the pack for
editing. One control per row, and the active pack is the one with the lit dot.
The read-only **示例规则** entry has no switch (its dot is inert), because a pack
that is not a file cannot be made active.

The report view's lens column also has a 设为生效 button. It is the same
`activate` call, kept because that column answers a different question — *which
pack do I want to judge this run with right now* — and a dropdown plus a button
is the right shape for a preview. The rule column's dot answers *which pack does
the observer use*; the report header names it, so the two cannot be confused.

**Order is evaluation order.** The grip on the left of every card is the only
reorder affordance: press, drag, and the list opens a slot under the pointer.
Cards are a fixed 96px tall and truncate — a long name, description, tag or id
never stretches the column. Four lines per card: name, the description from 信息,
the rule id on its own line, then the tags.

The attention level is the card's **frame**, not a chip inside it: the left edge
and border are red / amber / blue (严重 / 警告 / 提示), so the column reads at a
glance. `phase` (判读时机) is an engine detail and is not shown on the card.

The rule's **native JSON** sits in its own column beside the form, live: it is
the exact object that is saved, so what you read is what you distribute.
**放大** opens it in a dialog that can copy it or replace the rule with pasted
JSON (validated before it applies).

The rule panel is three numbered blocks, in the order a rule is thought about:

1. **信息** — name, description, tags, priority, and the **derived** 判读时机.
   Tags are **chips**: each tag is a small card with its own ✕, and a trailing
   **＋** card opens a one-line input (Enter commits, Esc cancels). No
   comma-separated string to get wrong.

   **判读时机 is not a control and not a field — it is read off the conditions.**
   A rule with no `facts.ended` condition is judged 全程 (`both`); `这一轮是否已结束
   = 是` pins it to 结束后 (`settled`); `= 否` pins it to 运行中 (`live`). `any`
   does not pin anything, because the other branches still work mid-run. The
   derivation lives in the engine (`impliedPhase` / `phaseOf` in
   `src/regimen/rule.ts`), so the CLI, the API and the editor cannot disagree,
   and `validatePack` rejects a legacy `phase` field that contradicts the
   conditions. Id, cooldown, suppression and the machine `reason` live in a
   collapsed **更多设置**.
2. **规则** — a plain-language reading of the current form, then the conditions.
   A preset palette (**＋常用条件**) offers the shapes most rules are
   ("命令失败数达到…", "连续失败达到…", "最近 2 分钟内失败…", "有进程没退出",
   "有进程 CPU 超过…%", "有进程内存超过…GB", "整机 CPU 超过…%", …).
   Pickers come from the catalogue, so a number field only offers number
   operators, a status field offers a select of its known values, and a window's
   `where` only offers payload fields of the event types you picked.
   **＋内容** adds a content condition in one row — pick 用户说过的话 / 代理说过的话
   / 代理的思考, an operator (包含 / 匹配正则 / 不包含…), and the text. It writes
   the same data a hand-written rule would
   (`{ field: "facts.text.thoughts", quant: "any", where: … "text" … }`), and
   reads back as one sentence: 代理的思考里有一条 匹配正则 「…」. Commands are
   matched through `facts.commandFacts`, where the exit code sits beside the text.
   There is **no "add group"**: `(A and B) or C` is a second rule, and the panel
   says so once.
3. **报告** — the level (four buttons, not a dropdown), the title with an
   **插入数据** menu for `{{facts.…}}`, an optional detail line, and the evidence
   the finding points at (checkbox chips for the common sources, free text for the
   rest). **在报告中查看 →** jumps to the tape.

The built-in defaults are read-only; the panel says so and offers to fork them
into an editable pack (which copies what is on screen, including your order).

### 报告编辑 — reports | sections | the section | the preview

```
┌ reports ───┬ sections ───────────────┬ 区块 5 · 表格 ──────────┬ 预览 · 这一轮 ──┐
│ ●内置报告  │ ⠿ 标题        header    │ 标题 [文件]            │ 运行报告 · run_1 │
│ ○原始报告  │ ⠿ 结论        verdict   │ 数据来源 [facts.…]      │ 触发结果          │
│ ●my-report │ ⠿ 触发结果    findings  │ 列 [路径][方式][+/−]    │ 一览              │
│ ＋新建     │ ⠿ 一览        stats     │ 筛选 [path][glob][…]   │ 命令              │
│ 下载       │ ⠿ 表格        table     │ 最多显示 [80]          │ 文件 (filtered)   │
│            │ ⠿ 表格        table     │ 没有内容时 [没有。]     │ …                │
│            │ ⠿ 段落        text      │                        │                  │
└────────────┴─────────────────────────┴────────────────────────┴──────────────────┘
```

A report is a `ReportSpec`, so this view edits **data**: the section list
reorders with the same grip as the rule list, the form is one block per kind, and
the right column runs the real renderer against the selected run. The preview is
not a mock — it is the document you will get, which is why a `{{facts.…}}` typo
shows up as 「取不到值」 instead of silently rendering empty.

The two built-ins are **内置报告** (what the editor ships) and **原始报告**
(`CLASSIC_REPORT` — Absence's original layout written as a spec, which is the
proof that a custom report can express anything the hard-coded one could).
Editing either forks it into a named copy first, exactly like a built-in rule
pack.

**A table/list/text section can carry a 筛选** — one field, one operator, one
value, evaluated by the same `matches()` a rule's `where` uses and applied before
sort and limit. That single control is what makes “only what changed under
`company/`” expressible, and it is the reason `CLASSIC_REPORT` can be data at
all: its four file lists (modified / created / observed / deleted) are one
`facts.files.byPath` source with four different filters.

### 事件流 — runs | events | the event

```
┌ runs ──────┬ events ──────────────┬ 1 基本信息 ───────────────────────┐
│ 全部事件   │ ⠿ 01 代理启动  +0s   │ 类型 [命令 ▾]  时间 [2026-…]      │
│ 第 1 轮    │ ⠿ 02 消息      +5s   │ 2 内容 ───────────────────────────│
│ 第 2 轮    │ ⠿ 03 命令      +10s  │ 命令 [npm test]  退出码 [1]        │
│ …          │ …                    │ 3 原始 JSON ──────────────────────│
│            │ [类型 ▾] ＋添加事件   │ { "command": "npm test", … }      │
└────────────┴──────────────────────┴───────────────────────────────────┘
```

The record is edited in three steps: pick the round, pick the event, edit the
event. Cards reorder with the same grip, so a command can be moved before the
`agent_end` that ignored it. The detail panel is the whole event: type, time, the
payload fields the catalogue says matter, and the raw JSON one disclosure away.

**全部事件** shows the whole stream instead of one round, for edits that cross a
run boundary. Adding an event inserts after the selected card, and before a
trailing `agent_end` (anything after it belongs to no run).

### 事件会话 — the leftmost column, and its ＋

```
┌ 事件会话 sessions ────────────────────────┐
│ ● 研究任务 · 两个交付物                   │
│   一次调研：…（内置演示）                 │
│ ● Absence 会话                       ✕   │
│   Absence 导入 · 复制自「chart · sess…」  │
│ ● 我的实验                           ✕   │
│ ＋                                        │
└──────────────────────────────────────────┘
```

The column lists the sessions you made, then the demos. Its **＋** opens a dialog
with two ways to add one:

- **空会话** — a blank stream, built event by event in 事件流.
- **当前会话 · 从 Absence 导入** — the agent session **Absence is observing**
  (`../daze`), not a conversation in this editor. This is the real thing: the
  events the agent actually produced, plus the resource samples its sampler
  recorded, so a `last N minutes` window rule or a CPU rule judges real data.

The import is a **snapshot, not a subscription**. When you press 导入, Chart's
API reads Absence once over the loopback — history, every archived event page,
the live session's in-memory tail (so a copy taken mid-run is not missing the
last second), and the bucketed metric series — and the editor stores **one deep
copy**. There is no cursor, no socket and no polling afterwards: what happens in
Absence next does not reach the copy, and editing the copy does not touch
Absence. The card keeps the provenance (`Absence 导入 · 复制自「…」，之后不再同步`).

The dialog's picker offers the sessions Absence has actually archived (a Pi-only
row has no events in Absence's database, so it would import empty), newest
first, capped at twenty, with the live one marked `●`. 当前会话 means the live
one — Absence's `GET /api/sessions/:id` answers 200 only for a session still in
its store, so liveness is asked, not guessed. When nothing is live the newest
archived session is offered, which is the one you were just in.

**Absence not running is normal, not an error.** The option is disabled and says
why (`连不上 http://127.0.0.1:8848（Absence 没在运行？）`); the empty session still
works. `npm run api` takes `--absence <url>` (or `ABSENCE_URL`) when Absence
listens somewhere else.

The dialog also owns the name, with the editor's usual rules — non-empty, not
already taken — and a free default per mode (`我的实验`, `Absence 会话`). Sessions
live in `localStorage` and the ✕ on a card deletes one (with the in-page confirm
dialog); the demos are not deletable.

The pack column lists the built-in defaults, a read-only **示例规则** pack
(`EXAMPLE_PACK` — twelve rules that each demonstrate one capability of the
language: globs on files, a window, a sequence, a quantifier, a regex, content
over the transcript, and the resource snapshot: CPU, memory, host saturation and
session averages), and then your own packs. Both read-only entries fork on the
first edit. The dot in front of a row is the 生效 switch; the row itself opens
the pack.

## Why no node canvas

n8n's canvas draws edges because data flows between nodes. A rule engine has no
edges: a rule is a flat list of conditions producing one finding. Drawing wires
would be a lie. The honest analogue is n8n's *other* UI — the IF/Filter condition
builder — plus the canvas's one good idea, **execute step**, which here becomes
**play the run**.

## Packs, JSON, and the API

The editor talks to a **PackIO**, so the backend is a detail:

- **磁盘 · API** — `npm run api` is running (Vite proxies `/api`), packs live in
  `.chart/rules/`, and an agent edits the same files with `curl`;
- **浏览器** — no API, packs live in `localStorage` and everything still works.

The top bar says which one you are on. Nothing else in the UI changes, because
the seam is the store, not the components.

Either way, a pack can be moved as JSON:

- **规则包 JSON** (packs column) opens the whole pack in a dialog: copy,
  download, or paste someone else's pack and **应用**. Applying to the read-only
  built-in defaults forks them into a named pack first.
- Every rule has a **原生 JSON** column next to its form — the exact object that
  is saved, live — with **放大** for a dialog that can replace the rule.

That is the distribution path: send a pack (or one rule) to another person or a
model, and paste it back. A pack can be *selected* (the lens) without being
*active* (the one the observer uses); the report column shows both.

Every question the editor asks is asked **in the page**, never by
`window.prompt` / `window.confirm`: naming a new pack opens a small dialog with
the name rules stated inline (the confirm button stays disabled until the name is
valid, and a taken name says so), and deleting a pack opens a confirm dialog that
names what is lost, focuses 取消, and closes on Esc. The pack name rules are the
store's own — the dialog validates with the same `PACK_NAME_RE` the writer uses.

## Not part of the library

`web/` is a dev tool: not a workspace of the package, not published, and nothing
in `src/` imports it. `chart` stays dependency-free; React and Vite live only
here.
