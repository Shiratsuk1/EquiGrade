import { ChevronRight } from "lucide-react";
import type { ScorePoint } from "../shared/types";
import { MathText } from "./Formula";

export function ScorePointGuidance({ point, defaultOpen = false }: { point: Pick<ScorePoint, "commonResponses" | "alternativeMethods" | "acceptedEquivalents">; defaultOpen?: boolean }) {
  const groups = [
    { label: "常见作答", items: point.commonResponses ?? [] },
    { label: "其他解法", items: point.alternativeMethods ?? [] },
    { label: "等价情况", items: point.acceptedEquivalents ?? [] }
  ].filter((group) => group.items.length > 0);
  const count = groups.reduce((sum, group) => sum + group.items.length, 0);
  if (!count) return null;
  return <details className="score-point-guidance" open={defaultOpen}>
    <summary><span>作答形式辅助</span><small>{count} 项</small><ChevronRight size={13} /></summary>
    <div className="score-point-guidance-groups">{groups.map((group) => <section key={group.label}><strong>{group.label}</strong><ul>{group.items.map((item, index) => <li key={`${group.label}-${index}`}><MathText value={item} formulaByDefault /></li>)}</ul></section>)}</div>
    <p>辅助示例不是答案白名单，列表外的数学或物理等价作答仍可得分。</p>
  </details>;
}
