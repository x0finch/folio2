import { NumberTicker } from "@folio/ui";
import { useBalancePrivacy } from "@/lib/hooks/use-balance-privacy";
import { useDisplayValue } from "@/lib/hooks/use-display-value";
import { Sensitive } from "./sensitive";

// The ticker rounds internally, so only the integer part rolls and the fraction is rendered
// separately. Scrubbing swaps the value on the same instance: a plain <span> has different
// metrics than the ticker's 1.1em×1ch columns and would make the layout jump.
const SCRUB_ROLL_SECONDS = 0.15;

export function AmountTicker({
  value,
  scrubbing = false,
  compact = false,
  className,
  fractionClassName,
}: {
  value: number;
  scrubbing?: boolean;
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
      {/* Truncate, don't pass the raw value: the ticker rounds, so $999.60 would become
          "$1,000" + ".60". startOnView={false} because streamed / hydrated numbers are already
          on screen. Scrubbing shortens the roll and drops the per-digit stagger. */}
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
