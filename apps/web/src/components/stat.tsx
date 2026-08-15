import { cn } from "@folio/ui";
import { GainSkeleton } from "./skeletons";

// 统计小件:muted xs label + mono 加粗值。hero 三指标与 perp 权益条共用
// (code review:此前两处 byte-for-byte 重复,排版调整会漏一处)。
export function Stat({
  label,
  value,
  pending = false,
  className,
}: {
  label: string;
  value: string;
  /**
   * 值**还在路上**。画一条骨架而不是占位符 —— `—` 在全站是「问过了,答不上来」的意思
   * (见 lib/delta-display 的三态),拿它当加载态用,就等于先给出一个结论再推翻它。
   */
  pending?: boolean;
  className?: string;
}) {
  return (
    <div>
      <div className="mb-0.5 text-muted-foreground text-xs">{label}</div>
      {/* 骨架与真值同高(text-sm 的行高),填充那一下不推挤下方内容。 */}
      {pending ? (
        <div className="flex h-5 items-center">
          <GainSkeleton className="w-24" />
        </div>
      ) : (
        <div className={cn("font-mono font-semibold text-sm tabular-nums", className)}>{value}</div>
      )}
    </div>
  );
}
