/**
 * The rule column: one fixed-height card per rule.
 *
 * Order is evaluation order, so it matters — but not enough to justify two arrow
 * buttons per card. The grip on the left is the whole affordance: press, drag,
 * and the list opens a slot under the pointer.
 *
 * Three lines, one per fact a reader needs:
 *
 *   name                                   level
 *   description (what the rule is for)     ← truncated
 *   tag · phase                            id (truncated)
 *
 * Cards never grow: every line is single-line with an ellipsis, and the editor on
 * the right is where the full text lives. Nothing here shows whether a rule fired
 * — judgement belongs to the report panel.
 */

import type { CSSProperties } from "react";
import type { Rule } from "../../../src/regimen/rule.ts";
import { zhLevel, zhPhase } from "../lib/plain.ts";
import { useDragSort } from "./useDragSort.ts";

export const RULE_CARD_HEIGHT = 82;
const RULE_CARD_GAP = 6;

export function RuleCardList({
  rules,
  selectedId,
  onSelect,
  onMove,
}: {
  rules: Rule[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onMove: (from: number, to: number) => void;
}) {
  const sort = useDragSort(rules.length, RULE_CARD_HEIGHT, RULE_CARD_GAP, onMove);

  return (
    <div ref={sort.listRef} className="sortable rule-cards">
      {rules.map((rule, position) => {
        const off = rule.enabled === false || rule.emit.level === "none";
        const tags = rule.emit.tags ?? [];
        return (
          <div
            key={rule.id}
            className={[
              "rule-card",
              rule.id === selectedId ? "sel" : "",
              off ? "off" : "",
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
            <div className="rule-card-main">
              <div className="rule-card-line">
                <span className="rule-name">{rule.name || rule.id}</span>
                <span className={`chip ${off ? "off" : rule.emit.level}`}>{off ? "关闭" : zhLevel(rule.emit.level)}</span>
              </div>
              <div className="rule-card-line">
                <span className="rule-desc">{rule.description || "（没有描述）"}</span>
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
                <span className={`chip ${rule.phase ?? "both"}`}>{zhPhase(rule.phase)}</span>
                <span className="spacer" />
                <span className="rule-id">{rule.id}</span>
              </div>
            </div>
          </div>
        );
      })}
      {rules.length === 0 ? <div className="empty">这个规则包还没有规则。</div> : null}
    </div>
  );
}
