import { SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { LogoAvatar, Select, SelectContent, SelectItem, SelectTrigger, toast } from "@folio/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { storeCurrency, usePreferCurrency } from "@/lib/hooks/use-prefer-currency";
import { currencyPreferenceQuery } from "@/lib/queries/preferences";

// Row content shared by items and the trigger: logo (base64 data URI in SUPPORTED_CURRENCIES) + localized label.
function CurrencyRow({
  code,
  name,
  logo,
  symbol,
}: {
  code: string;
  name: string;
  logo: string;
  symbol?: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <LogoAvatar src={logo} fallback={code} size="sm" />
      <span className="truncate">{`${symbol ? `${symbol} ` : ""}${code} ${name}`}</span>
    </span>
  );
}

// The trigger renders the selected item itself (not SelectValue, which only takes a string label
// and can't hold a logo).
export function CurrencySwitcher() {
  const queryClient = useQueryClient();
  const t = useTranslations("Currency");
  const { currency } = usePreferCurrency();

  // Order matters: the code is the shell's `useSuspenseQuery` key, so fetch the new rate into the
  // cache before writing the code, else the shell suspends into a skeleton flash.
  // Without a rate the server falls back to USD wholesale (reads don't go out; the rate is warmed
  // hourly). The code is still written; tell the user so the click doesn't look dead.
  const setCurrency = useMutation({
    mutationFn: async (code: string) => {
      const preference = await queryClient.ensureQueryData(currencyPreferenceQuery(code));
      storeCurrency(code);
      if (preference.currency.code !== code) toast.message(t("noRateYet", { code }));
    },
  });

  function set(next: string) {
    if (next === currency.code) return;
    setCurrency.mutate(next);
  }

  return (
    <Select value={currency.code} onValueChange={set} className="w-40">
      {/* rounded-full!: beUI Select's radius comes from framer inline style, so override with important.
          bg-muted dark:bg-background matches the settings segmented-control track. */}
      <SelectTrigger
        aria-label="Display currency"
        className="rounded-full! bg-muted dark:bg-background"
      >
        <CurrencyRow
          code={currency.code}
          name={t(currency.code)}
          logo={currency.logo}
          symbol={currency.symbol}
        />
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_CURRENCIES.map((c) => (
          <SelectItem key={c.code} value={c.code}>
            <CurrencyRow code={c.code} name={t(c.code)} logo={c.logo} symbol={c.symbol} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
