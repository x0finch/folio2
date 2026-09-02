import { NumberTicker } from "@folio/ui";
import { useDisplayValue } from "@/lib/hooks/use-display-value";

// **一个会滚的大额金额。** 排版由调用方给,这里只管三件调用方不该各写一遍的事:
//
// ① **整数走滚动数字,小数另算。** ticker 内部 `Math.round`,整个金额喂进去分位恒为 `.00`。
// ② **划动读数(#470 片7)在同一个元素里换值。** 换成平铺 `<span>` 就是换盒子 —— ticker 的每个
//    数字是 `1.1em` 高、`1ch` 宽的滚动列,同号字下比纯文本高一截宽一截(实测 52.8×367.2 vs
//    48.5×357.6),底下的内容会跟着跳。所以静止与划动共用**同一个实例**,只换 value。
// ③ **划动时滚动时长收短。**
const SCRUB_ROLL_SECONDS = 0.15;

export function AmountTicker({
  value,
  scrubbing = false,
  compact = false,
  className,
  fractionClassName,
}: {
  value: number;
  /** 正在划动读数 —— 滚动时长收短到跟得上指针(#470 片7)。 */
  scrubbing?: boolean;
  /** 紧凑模式:整串(如 `$43.69M`)喂 ticker,数字位照样逐位滚、`$`/`.`/`M` 静态。
      紧凑记法自带舍入,不会有 `$999.60 → $1000` 的进位问题,所以**不拆小数**(拆了 `.69M`
      会连着单位一起掉进小数段)。 */
  compact?: boolean;
  /** 整数段的排版。 */
  className?: string;
  /** 小数段的排版(通常比整数小一号、muted)。 */
  fractionClassName?: string;
}) {
  const usd = useDisplayValue();
  if (compact) {
    return (
      <NumberTicker
        value={value}
        startOnView={false}
        duration={scrubbing ? SCRUB_ROLL_SECONDS : undefined}
        stagger={scrubbing ? 0 : undefined}
        format={(n) => usd(n, { compact: true })}
        className={className}
      />
    );
  }
  const formatted = usd(value);
  const dot = formatted.lastIndexOf(".");
  const fraction = dot >= 0 ? formatted.slice(dot + 1) : null;
  return (
    <span className="flex items-baseline">
      {/* 喂给 ticker 的是**截断**后的整数,不是原值:它内部 `Math.round`,而分位是我们自己另外
          渲染的 —— 原值直接进去时 `$999.60` 会被进位成「$1,000」再配上「.60」,凭空多一块钱。
          startOnView={false}:数据一到就滚一次。默认要等进视口,而流式补数 / hydration 时数字
          已经在屏上,再等会从 0 重滚一遍。
          划动时 `duration` 收短、`stagger` 归零(逐位延迟是入场的花样,读数时那就是纯延迟)。 */}
      <NumberTicker
        value={Math.trunc(value)}
        startOnView={false}
        duration={scrubbing ? SCRUB_ROLL_SECONDS : undefined}
        stagger={scrubbing ? 0 : undefined}
        format={(n) => usd(n).split(".")[0]}
        className={className}
      />
      {fraction && <span className={fractionClassName}>.{fraction}</span>}
    </span>
  );
}
