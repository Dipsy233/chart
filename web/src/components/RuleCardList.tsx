/**
 * The rule column: one fixed-height card per rule.
 *
 * Order is evaluation order, so it matters — but not enough to justify two arrow
 * buttons per card. The grip on the left is the whole affordance: press, drag,
 * and the list opens a slot under the pointer.
 *
 * Four lines, one per fact a reader needs:
 *
 *   name
 *   description (what the rule is for)      ← truncated
 *   id (the machine key, full width)        ← truncated
 *   tag · tag · tag
 *
 * The level is **not** a chip inside the card: it is the card's own border and
 * left edge (red = critical, amber = warning, blue = info), so the column reads
 * top-to-bottom at a glance. The live/settled phase is an engine detail and is
 * not shown here at all.
 *
 * **Deleting happens here**, on the card's top-right ✕ — not in the editor
 * beside it. One place per action: the list is where a rule lives and where it
 * is removed, and the panel on the right is for changing one. `onDelete` is
 * absent for a read-only pack, so the built-in has no ✕ at all.
 *
 * Cards never grow: every line is single-line with an ellipsis, and the editor on
 * the right is where the full text lives. Nothing here shows whether a rule fired
 * — judgement belongs to the report panel.
 */

import type { CSSProperties } from "react";
import type { Rule } from "../../../src/regimen/rule.ts";
import { useDragSort } from "./useDragSort.ts";

export const RULE_CARD_HEIGHT = 96;
const RULE_CARD_GAP = 6;

export function RuleCardList({
  rules,
  selectedId,
  onSelect,
  onMove,
  onDelete,
}: {
  rules: Rule[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onMove: (from: number, to: number) => void;
  /** Absent for a read-only pack: the built-in has no ✕. */
  onDelete?: (id: string) => void;
}) {
  const sort = useDragSort(rules.length, RULE_CARD_HEIGHT, RULE_CARD_GAP, onMove);

  return (
    <div ref={sort.listRef} className="sortable rule-cards">
      {rules.map((rule, position) => {
        const off = rule.enabled === false || rule.emit.level === "none";
        const level = off ? "off" : rule.emit.level;
        const tags = rule.emit.tags ?? [];
        return (
          <div
            key={rule.id}
            className={[
              "card",
              "rule-card",
              level,
              rule.id === selectedId ? "sel" : "",
              sort.dragging === position ? "dragging" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={sort.itemStyle(position) as CSSProperties}
            onClick={() => onSelect(rule.id)}
            title={`${rule.name ?? rule.id}\n${rule.description ?? ""}\n${rule.id}`}
          >
            <span className="grip" {...sort.handleProps(position)} title="按住拖动，调整判读顺序">
              ⠿
            </span>
            {onDelete ? (
              <button
                type="button"
                className="card-del"
                title={`删除规则「${rule.name ?? rule.id}」`}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(rule.id);
                }}
              >
                ✕
              </button>
            ) : null}
            <div className="rule-card-main">
              <div className="rule-card-line">
                <span className="rule-card-name">{rule.name || rule.id}</span>
                {off ? <span className="rule-card-off">已停用</span> : null}
              </div>
              <div className="rule-card-line">
                <span className="rule-card-desc">{rule.description || "（没有描述）"}</span>
              </div>
              <div className="rule-card-line">
                <span className="rule-card-id" title={rule.id}>
                  {rule.id}
                </span>
              </div>
              <div className="rule-card-line">
                {tags.length > 0 ? (
                  <span className="rule-tags">
                    {tags.map((tag) => (
                      <span className="rule-tag" key={tag} title={tag}>
                        {tag}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="rule-tag empty">无标签</span>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {rules.length === 0 ? <div className="empty">这个规则包还没有规则。</div> : null}
    </div>
  );
}
