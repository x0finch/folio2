import type { ConnectorId } from "@folio/connectors";
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatefulButton,
} from "@folio/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { isManual } from "@/lib/core/manual";
import type { TokenOption } from "@/lib/core/token-model";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { useTokenPrice } from "@/lib/hooks/use-token-price";
import { createAccount } from "@/lib/server/accounts";
import type { InputSpec } from "@/lib/server/creds";
import { manualTokensJson } from "./manual-tokens";
import { TokenCombobox } from "./token-combobox";

// Local ScriptType: the provider-side one pulls in @scure derivation libs, which can't enter the client bundle.
type ScriptType = "native" | "nested" | "taproot" | "legacy";

// Recommended option first; addressPrefix hints at the derived address start.
const BTC_SCRIPT_OPTIONS: { value: ScriptType; label: string; addressPrefix: string }[] = [
  { value: "native", label: "Native SegWit", addressPrefix: "bc1q…" },
  { value: "nested", label: "Nested SegWit", addressPrefix: "3…" },
  { value: "taproot", label: "Taproot", addressPrefix: "bc1p…" },
  { value: "legacy", label: "Legacy", addressPrefix: "1…" },
];

const EXT_PUBKEY_RE = /^(xpub|ypub|zpub)/;

const isExtendedPubkey = (id: string): boolean => EXT_PUBKEY_RE.test(id.trim());
// Only a bare xpub is ambiguous and needs a user choice; ypub/zpub prefixes fix the type.
const isBareXpub = (id: string): boolean => id.trim().startsWith("xpub");

// Matches the provider's recommendedScript.
function recommendedScript(id: string): ScriptType {
  return id.trim().startsWith("ypub") ? "nested" : "native";
}

async function submitAccount(
  connectorId: ConnectorId,
  label: string,
  values: Record<string, string>,
  portfolioId: string | undefined,
) {
  // Defaults to the server's default portfolio when undefined.
  return createAccount({ data: { connectorId, label, values, portfolioId } });
}

// Manual account: a single `tokens` creds value, kept as local scalars and serialized into
// `values.tokens` (numbers stay strings; the manualToken validator coerces).
function ManualFields({
  setValues,
}: {
  setValues: (fn: (v: Record<string, string>) => Record<string, string>) => void;
}) {
  const t = useTranslations("Accounts");
  const [picked, setPicked] = useState<TokenOption | null>(null);
  const [manualMode, setManualMode] = useState(false);
  // Shared hook owns price fetching, the race guard and busy state.
  const { fetchPrice, cancel: cancelPriceFetch, busy: priceBusy } = useTokenPrice();
  // Local scalars of the first token, serialized by the effect below.
  const [tok, setTok] = useState({ symbol: "", amount: "", unitPrice: "", ticket: "" });
  const patch = (p: Partial<typeof tok>) => setTok((prev) => ({ ...prev, ...p }));

  // Side effect lives in an effect, not in a setState updater.
  useEffect(() => {
    setValues(() => ({ tokens: manualTokensJson(tok) }));
  }, [tok, setValues]);

  // The ticket is passed through opaquely and returned to the server inside the `tokens` JSON.
  async function onPick(token: TokenOption | null) {
    setPicked(token);
    if (!token) {
      cancelPriceFetch(); // a late in-flight price would fill the emptied field
      patch({ symbol: "", ticket: "", unitPrice: "" });
      return;
    }
    const { ticket } = token;
    patch({ symbol: token.symbol.toUpperCase(), ticket });
    // Use the price already shown in the dropdown: instant, and it is the number the user clicked.
    if (token.price != null) {
      cancelPriceFetch();
      patch({ unitPrice: String(token.price) });
      return;
    }
    // No displayed price (e.g. refresh failed): fetch once as a fallback.
    await fetchPrice(ticket, (unitPrice) => patch({ unitPrice: String(unitPrice) }));
  }

  // Custom symbol has no market price: clear any auto-filled price and cancel an in-flight fetch.
  function enterManual(symbol: string) {
    cancelPriceFetch();
    setPicked(null);
    setManualMode(true);
    patch({ symbol, ticket: "", unitPrice: "" });
  }

  // Back to search: reset to a clean pick state.
  function leaveManual() {
    setManualMode(false);
    patch({ symbol: "", unitPrice: "" });
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="m-token">{t("token")}</Label>
        {manualMode ? (
          <>
            <Input
              id="m-token"
              required
              autoComplete="off"
              value={tok.symbol}
              onChange={(v) => patch({ symbol: v })}
              placeholder="BTC"
            />
            <button
              type="button"
              className="self-start text-muted-foreground text-xs underline"
              onClick={leaveManual}
            >
              {t("searchInstead")}
            </button>
          </>
        ) : (
          <>
            <TokenCombobox value={picked} onChange={onPick} onManual={enterManual} />
            <button
              type="button"
              className="self-start text-muted-foreground text-xs underline"
              onClick={() => enterManual(tok.symbol)}
            >
              {t("enterManually")}
            </button>
          </>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="m-amount">{t("amount")}</Label>
        <Input
          id="m-amount"
          required
          inputMode="decimal"
          value={tok.amount}
          onChange={(v) => patch({ amount: v })}
          placeholder="0.0"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="m-price">{t("unitPrice")}</Label>
        <Input
          id="m-price"
          required
          inputMode="decimal"
          value={tok.unitPrice}
          onChange={(v) => patch({ unitPrice: v })}
          placeholder="0.0"
        />
        <p className="text-muted-foreground text-xs">
          {priceBusy ? t("fetchingPrice") : t("unitPriceHint")}
        </p>
      </div>
    </>
  );
}

// One field path for adding an account (idPrefix "add") and re-entering credentials (idPrefix
// "cred" + hint = credsSafe, so semi fields show the masked fragment for recognition).
export function GenericFields({
  specs,
  values,
  setValues,
  idPrefix = "add",
  hint,
}: {
  specs: InputSpec[];
  values: Record<string, string>;
  setValues: (fn: (v: Record<string, string>) => Record<string, string>) => void;
  idPrefix?: string;
  hint?: Record<string, string>; // safeView projection: masked semi fragments
}) {
  const ti = useTranslations("Inputs");
  const ta = useTranslations("Accounts");
  return (
    <>
      {specs.map((s) => {
        // Only semi fields have a recognizable masked fragment (public is known, secret has no projection).
        const recorded = s.type === "semi" ? hint?.[s.key] : undefined;
        return (
          <div key={s.key} className="flex flex-col gap-2">
            <Label htmlFor={`${idPrefix}-${s.key}`}>{ti(s.label)}</Label>
            {recorded && (
              <p className="text-muted-foreground text-xs">
                {ta("credHint", { field: ti(s.label), hint: recorded })}
              </p>
            )}
            <Input
              id={`${idPrefix}-${s.key}`}
              type={s.type === "secret" ? "password" : "text"}
              required={!s.optional}
              // `new-password`: Chrome ignores autoComplete="off" on password inputs and would autofill
              // the site login; this also breaks the username/password pairing so API keys aren't filled.
              autoComplete={s.type === "secret" ? "new-password" : "off"}
              value={values[s.key] ?? ""}
              placeholder={s.desc ? ti(s.desc) : undefined}
              onChange={(val) => setValues((v) => ({ ...v, [s.key]: val }))}
            />
          </div>
        );
      })}
    </>
  );
}

// Custom branch: scriptType select shown dynamically once an extended pubkey is detected.
function BitcoinFields({
  specs,
  values,
  setValues,
}: {
  specs: InputSpec[];
  values: Record<string, string>;
  setValues: (fn: (v: Record<string, string>) => Record<string, string>) => void;
}) {
  const ti = useTranslations("Inputs");
  const idSpec = specs.find((s) => s.key === "addressOrXpub");
  const id = values.addressOrXpub ?? "";
  // Read-only label for ypub/zpub, whose prefix fixes the type.
  const detected = BTC_SCRIPT_OPTIONS.find((o) => o.value === recommendedScript(id));
  const detectedLabel = detected ? `${ti(detected.label)} · ${detected.addressPrefix}` : "";
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="add-addressOrXpub">{ti(idSpec?.label ?? "Bitcoin address or xpub")}</Label>
        <Input
          id="add-addressOrXpub"
          required
          value={id}
          placeholder={idSpec?.desc ? ti(idSpec.desc) : undefined}
          onChange={(val) =>
            setValues((v) => {
              const next: Record<string, string> = { ...v, addressOrXpub: val };
              // Only a bare xpub is ambiguous and needs scriptType.
              if (isBareXpub(val)) next.scriptType = recommendedScript(val);
              else delete next.scriptType;
              return next;
            })
          }
        />
      </div>
      {/* Bare xpub: ambiguous, user picks (default Native). */}
      {isBareXpub(id) && (
        <div className="flex flex-col gap-2">
          <Label>{ti("Address type")}</Label>
          <Select
            value={values.scriptType ?? recommendedScript(id)}
            onValueChange={(v) => setValues((prev) => ({ ...prev, scriptType: v }))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BTC_SCRIPT_OPTIONS.map((o) => (
                // Single-string children: SelectItem only shows a string as the trigger label.
                <SelectItem key={o.value} value={o.value}>
                  {`${ti(o.label)} · ${o.addressPrefix}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{ti("btcScriptHint")}</p>
        </div>
      )}
      {/* ypub/zpub: type fixed by prefix, read-only. */}
      {isExtendedPubkey(id) && !isBareXpub(id) && (
        <div className="flex flex-col gap-2">
          <Label>{ti("Address type")}</Label>
          <p className="text-muted-foreground text-sm">{detectedLabel}</p>
        </div>
      )}
    </>
  );
}

// key={connectorId} remounts on connector change, clearing local state.
export function AccountForm({
  connectorId,
  specs,
  onDone,
}: {
  connectorId: ConnectorId;
  specs: InputSpec[];
  onDone: (accountId: string) => void;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const { selectedId, defaultId } = usePortfolio();
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const mutation = useMutation({
    // Omit for the default portfolio (the server defaults to it), saving a redundant reassignment.
    mutationFn: () =>
      submitAccount(connectorId, label, values, selectedId === defaultId ? undefined : selectedId),
    onSuccess: (account) => onDone(account.id),
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="add-label">{t("label")}</Label>
        <Input
          id="add-label"
          required
          value={label}
          onChange={(v) => setLabel(v)}
          placeholder={
            isManual(connectorId) ? t("manualLabelPlaceholder") : t("walletLabelPlaceholder")
          }
        />
      </div>
      {isManual(connectorId) ? (
        <ManualFields setValues={setValues} />
      ) : connectorId === "bitcoin" ? (
        <BitcoinFields specs={specs} values={values} setValues={setValues} />
      ) : (
        <GenericFields specs={specs} values={values} setValues={setValues} />
      )}
      {mutation.isError && (
        <p className="text-destructive text-sm">
          {mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
        </p>
      )}
      <StatefulButton
        type="submit"
        state={mutation.isPending ? "loading" : "idle"}
        loadingText={tc("verifying")}
        disabled={mutation.isPending}
        className="self-end"
      >
        {t("addAccount")}
      </StatefulButton>
    </form>
  );
}
