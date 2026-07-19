import type { ConnectorId } from "@folio/connectors";
import type { TokenInfo } from "@folio/tokens";
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
import { useRef, useState } from "react";
import { useTranslations } from "use-intl";
import {
  BTC_SCRIPT_OPTIONS,
  isBareXpub,
  isExtendedPubkey,
  recommendedScript,
} from "../lib/bitcoin-scripts";
import { createAccount } from "../lib/server/accounts";
import type { InputSpec } from "../lib/server/credentials";
import { tokenPrice } from "../lib/server/tokens";
import { TokenCombobox } from "./token-combobox";

// 添加账户的录入字段与提交(A4 从 add-account-sheet 抽出,供 AddAccountModal 复用)。connector-driven 创建(#55):
// 字段组件按 connector.account.creds 的 key 写入 values,原样透传给统一 createAccount(校验/加密/落库全在服务端
// 按 connectorId 驱动)。manual 选币用 TokenCombobox(内联下推,取代旧 TokenPicker 浮层)。
async function submitAccount(
  connectorId: ConnectorId,
  label: string,
  values: Record<string, string>,
) {
  return createAccount({ data: { connectorId, label, values } });
}

// manual 的字段:富控件(TokenCombobox 选币联动 symbol+identifier+autofill 单价 / 数字)。
// 找不到的币可切"手动输入 symbol"(不关联,identifier 空)。
function ManualFields({
  values,
  setValues,
}: {
  values: Record<string, string>;
  setValues: (fn: (v: Record<string, string>) => Record<string, string>) => void;
}) {
  const t = useTranslations("Accounts");
  const [picked, setPicked] = useState<TokenInfo | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [priceBusy, setPriceBusy] = useState(false);
  const priceReqRef = useRef(0);

  // 选中币:填 symbol+identifier,并自动取市价预填 unitPrice(用户可改;竞态守卫)。
  async function onPick(token: TokenInfo | null) {
    setPicked(token);
    if (!token) {
      setValues((v) => ({ ...v, symbol: "", identifier: "" }));
      return;
    }
    setValues((v) => ({
      ...v,
      symbol: token.symbol.toUpperCase(),
      identifier: token.ref.identifier,
    }));
    const reqId = ++priceReqRef.current;
    setPriceBusy(true);
    try {
      const p = await tokenPrice({ data: { identifier: token.ref.identifier } });
      if (priceReqRef.current === reqId && p?.unitPrice != null) {
        setValues((v) => ({ ...v, unitPrice: String(p.unitPrice) }));
      }
    } catch {
      // 取价失败不阻断:手填单价即可
    } finally {
      if (priceReqRef.current === reqId) setPriceBusy(false);
    }
  }

  const set = (key: string, v: string) => setValues((vs) => ({ ...vs, [key]: v }));

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
              value={values.symbol ?? ""}
              onChange={(v) => set("symbol", v)}
              placeholder="BTC"
            />
            <button
              type="button"
              className="self-start text-muted-foreground text-xs underline"
              onClick={() => {
                setManualMode(false);
                set("symbol", "");
              }}
            >
              {t("searchInstead")}
            </button>
          </>
        ) : (
          <>
            <TokenCombobox
              value={picked}
              onChange={onPick}
              onManual={(q) => {
                setManualMode(true);
                setValues((v) => ({ ...v, symbol: q, identifier: "" }));
              }}
            />
            <button
              type="button"
              className="self-start text-muted-foreground text-xs underline"
              onClick={() => setManualMode(true)}
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
          value={values.amount ?? ""}
          onChange={(v) => set("amount", v)}
          placeholder="0.0"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="m-price">{t("unitPrice")}</Label>
        <Input
          id="m-price"
          required
          inputMode="decimal"
          value={values.unitPrice ?? ""}
          onChange={(v) => set("unitPrice", v)}
          placeholder="0.0"
        />
        <p className="text-muted-foreground text-xs">
          {priceBusy ? t("fetchingPrice") : t("unitPriceHint")}
        </p>
      </div>
    </>
  );
}

// 通用字段(onchain/exchange/perp):按 credentialSpecs 渲染(secret→password,其余 text);label 走 Inputs i18n。
function GenericFields({
  specs,
  values,
  setValues,
}: {
  specs: InputSpec[];
  values: Record<string, string>;
  setValues: (fn: (v: Record<string, string>) => Record<string, string>) => void;
}) {
  const ti = useTranslations("Inputs");
  return (
    <>
      {specs.map((s) => (
        <div key={s.key} className="flex flex-col gap-2">
          <Label htmlFor={`add-${s.key}`}>{ti(s.label)}</Label>
          <Input
            id={`add-${s.key}`}
            type={s.type === "secret" ? "password" : "text"}
            required={s.type !== "public" || s.key === "address"}
            // secret 用 new-password:Chrome 对 password 框忽略 autoComplete="off",会回填本站登录账号/密码;
            // 标成"新密码"既不回填,也打断"前一个文本框=用户名"的登录表单配对,连带 API Key 也不再被填。
            autoComplete={s.type === "secret" ? "new-password" : "off"}
            value={values[s.key] ?? ""}
            placeholder={s.desc ? ti(s.desc) : undefined}
            onChange={(val) => setValues((v) => ({ ...v, [s.key]: val }))}
          />
        </div>
      ))}
    </>
  );
}

// Bitcoin 字段:单 identifier(地址或扩展公钥),检测到扩展公钥后动态显示脚本类型下拉、按前缀预选。
// ProviderInputType 无 enum → 脚本类型的 select + 动态显隐走本定制分支(仿 manual/perp),不走 GenericFields。
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
  // ypub/zpub 前缀已定类型的只读展示文案(具名变量,不在 JSX 里塞 IIFE)。
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
              // 只有裸 xpub 才歧义、需 scriptType(默认 Native);ypub/zpub 前缀已定、单地址无关 → 不带。
              if (isBareXpub(val)) next.scriptType = recommendedScript(val);
              else delete next.scriptType;
              return next;
            })
          }
        />
      </div>
      {/* 裸 xpub:歧义 → 让用户选(默认 Native,可改)。 */}
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
                // 单字符串 children:SelectItem 才会把它作为 trigger 显示的 label(JSX 会回退成 value)。
                // 拼上地址前缀,让用户按自己钱包地址的开头对上类型。
                <SelectItem key={o.value} value={o.value}>
                  {`${ti(o.label)} · ${o.addressPrefix}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{ti("btcScriptHint")}</p>
        </div>
      )}
      {/* ypub/zpub:前缀已确定类型 → 只读展示,不必选。 */}
      {isExtendedPubkey(id) && !isBareXpub(id) && (
        <div className="flex flex-col gap-1.5">
          <Label>{ti("Address type")}</Label>
          <p className="text-muted-foreground text-sm">{detectedLabel}</p>
        </div>
      )}
    </>
  );
}

// 单个 connector 的录入表单。key={connectorId} 重挂 → 切 connector 自动清空本地态(不用 useEffect→setState)。
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
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const mutation = useMutation({
    mutationFn: () => submitAccount(connectorId, label, values),
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
            connectorId === "manual" ? t("manualLabelPlaceholder") : t("walletLabelPlaceholder")
          }
        />
      </div>
      {connectorId === "manual" ? (
        <ManualFields values={values} setValues={setValues} />
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
        className="self-start"
      >
        {t("addAccount")}
      </StatefulButton>
    </form>
  );
}
