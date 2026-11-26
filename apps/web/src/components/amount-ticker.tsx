import { NumberTicker } from "@folio/ui";
import { useBalancePrivacy } from "@/lib/hooks/use-balance-privacy";
import { useDisplayValue } from "@/lib/hooks/use-display-value";
import { Sensitive } from "./sensitive";

// The ticker rounds internally, so only the integer part rolls and the fraction is rendered
// separately.

export function AmountTicker({
  value,
  compact = false,
  className,
  fractionClassName,
}: {
  value: number;
  /** The whole compact string rolls; compact notation already rounds, so no fraction split. */
  compact?: boolean;
  className?: string;
  fractionClassName?: string;
}) {
  const usd = useDisplayValue();
  const { hidden } = useBalancePrivacy();
  // Static blurred value when hidden: a rolling ticker would re-rasterize the blur every frame.
  if (hidden) {
    return <Sensitive className={className}>{usd(value, { compact })}</Sensitive>;
  }
  if (compact) {
    return (
      <NumberTicker
        value={value}
        startOnView={false}
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
      {/* Truncate, don't pass the raw value: the ticker rounds, so $999.60 would become
          "$1,000" + ".60". startOnView={false} because streamed / hydrated numbers are already
          on screen. */}
      <NumberTicker
        value={Math.trunc(value)}
        startOnView={false}
        format={(n) => usd(n).split(".")[0]}
        className={className}
      />
      {fraction && <span className={fractionClassName}>.{fraction}</span>}
    </span>
  );
}
