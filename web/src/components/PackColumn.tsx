/**
 * The pack column.
 *
 * A pack is a set of rules on disk (or the built-in defaults). Selecting a row
 * opens that pack for editing; the dot before the name is the switch — click it
 * to make that pack the *active* one. One control per row, and the dot is it.
 *
 * One entry is not a file: 内置默认, the shipped pack. It is read-only, and
 * editing it forks a named copy.
 *
 * The rules view gets the full column (new / import / export / delete); the
 * report view gets the compact one, because it only needs to pick a lens.
 */

import { DEFAULT_PACK } from "../../../src/regimen/defaults.ts";
import type { PackSummary } from "../../../src/store/packStore.ts";

export function PackColumn({
  packs,
  packName,
  onSelect,
  onCreate,
  onActivate,
  onDelete,
  onImport,
  onExport,
  onShowJson,
  compact,
}: {
  packs: PackSummary[];
  packName: string | undefined;
  onSelect: (name: string | undefined) => void;
  onCreate?: () => void;
  onActivate?: (name: string | undefined) => void;
  onDelete?: (name: string) => void;
  onImport?: () => void;
  onExport?: () => void;
  /** Open the pack-as-JSON dialog (view, copy, paste, distribute). */
  onShowJson?: () => void;
  compact?: boolean;
}) {
  const activeName = packs.find((summary) => summary.active)?.name;
  return (
    <div className={`col packs-col${compact ? " compact" : ""}`}>
      <div className="pane-head">
        <span>规则包 packs</span>
        <span className="spacer" />
        {onCreate ? (
          <button className="btn tiny" onClick={onCreate} title="把当前规则包复制成一份可编辑的新规则包">
            ＋新建
          </button>
        ) : null}
      </div>
      <div className="pane-body stack" style={{ gap: 3 }}>
        <PackRow
          name={undefined}
          label="内置默认"
          count={DEFAULT_PACK.rules.length}
          active={activeName === undefined}
          selected={packName === undefined}
          onSelect={() => onSelect(undefined)}
          onActivate={onActivate ? () => onActivate(undefined) : undefined}
          compact={compact}
        />
        {packs.map((summary) => (
          <PackRow
            key={summary.name}
            name={summary.name}
            label={summary.name}
            count={summary.rules}
            active={summary.active}
            selected={packName === summary.name}
            issues={summary.issues.length}
            onSelect={() => onSelect(summary.name)}
            onActivate={onActivate ? () => onActivate(summary.name) : undefined}
            onDelete={onDelete ? () => onDelete(summary.name) : undefined}
            compact={compact}
          />
        ))}
        {packs.length === 0 && !compact ? (
          <div className="zh-hint" style={{ marginTop: 6 }}>
            还没有自己的规则包。「＋新建」会把当前规则包复制成一份可编辑的副本。
          </div>
        ) : null}

        {!compact && (onImport || onExport || onShowJson) ? (
          <div className="pack-actions">
            {onShowJson ? (
              <button className="btn tiny" onClick={onShowJson} title="把整个规则包作为 JSON 查看 / 复制 / 粘贴导入">
                {"{ }"} 规则包 JSON
              </button>
            ) : null}
            {onImport ? (
              <button className="btn tiny" onClick={onImport} title="从文件导入一个规则包">
                导入文件
              </button>
            ) : null}
            {onExport ? (
              <button className="btn tiny" onClick={onExport} title="下载成 JSON 文件">
                下载
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PackRow({
  label,
  count,
  active,
  selected,
  issues,
  onSelect,
  onActivate,
  onDelete,
  compact,
  hint,
}: {
  name: string | undefined;
  label: string;
  count: number;
  active: boolean;
  selected: boolean;
  issues?: number;
  onSelect: () => void;
  onActivate?: () => void;
  onDelete?: () => void;
  compact?: boolean;
  hint?: string;
}) {
  return (
    <div className={`pack-row${selected ? " sel" : ""}`} onClick={onSelect} title={hint ?? label}>
      {onActivate ? (
        <button
          type="button"
          className={`pack-dot${active ? " on" : ""}`}
          aria-pressed={active}
          aria-label={active ? `${label} 已是生效规则包` : `把 ${label} 设为生效规则包`}
          title={active ? "当前生效的规则包" : "点一下设为生效"}
          onClick={(event) => {
            // The dot switches packs; the rest of the row opens the pack.
            event.stopPropagation();
            onActivate();
          }}
        />
      ) : (
        <span
          className={`pack-dot static${active ? " on" : ""}`}
          title={active ? "当前生效的规则包" : "未生效"}
        />
      )}
      <span className="pack-name">{label}</span>
      {issues ? <span className="pack-bad" title={`${issues} 处问题`}>!</span> : null}
      <span className="pack-count">{count}</span>
      {/* The same ✕ every other card list uses, in the same place: the right end.
          A row that cannot be deleted (the built-in, or a read-only report's
          compact column) simply has no button. */}
      {!compact && onDelete ? (
        <button
          type="button"
          className="card-del inline"
          title={`删除规则包「${label}」`}
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
