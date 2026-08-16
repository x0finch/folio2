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
import { isManual } from "../lib/core/manual";
import { usePortfolio } from "../lib/hooks/use-portfolio";
import { useTokenPrice } from "../lib/hooks/use-token-price";
import { createAccount } from "../lib/server/accounts";
import type { InputSpec } from "../lib/server/internal/creds";
import type { TokenOption } from "../lib/server/internal/tokens";
import { manualTokensJson } from "./manual-tokens";
import { TokenCombobox } from "./token-combobox";

// Bitcoin add-account 的脚本类型 UI 辅助(客户端安全:纯字符串,不引 @scure 派生库)。
// ScriptType 本地定义(与 @folio/bitcoin-derive 的 provider 侧同口径;那份含 @scure 派生库,不能进客户端 bundle)。
type ScriptType = "native" | "nested" | "taproot" | "legacy";

// 下拉选项(推荐项排前);label 走 Inputs i18n,addressPrefix 提示该类型派生地址的开头(语言无关,直接展示)。
const BTC_SCRIPT_OPTIONS: { value: ScriptType; label: string; addressPrefix: string }[] = [
  { value: "native", label: "Native SegWit", addressPrefix: "bc1q…" },
  { value: "nested", label: "Nested SegWit", addressPrefix: "3…" },
  { value: "taproot", label: "Taproot", addressPrefix: "bc1p…" },
  { value: "legacy", label: "Legacy", addressPrefix: "1…" },
];

const EXT_PUBKEY_RE = /^(xpub|ypub|zpub)/;

// 是否扩展公钥(xpub/ypub/zpub)。
const isExtendedPubkey = (id: string): boolean => EXT_PUBKEY_RE.test(id.trim());
// 是否裸 xpub —— 只有它脚本类型才歧义、需用户选;ypub/zpub 前缀已定,展示为只读。
const isBareXpub = (id: string): boolean => id.trim().startsWith("xpub");

// 前缀预选/识别:ypub→Nested、zpub→Native、裸 xpub→Native(与 provider recommendedScript 一致)。
function recommendedScript(id: string): ScriptType {
  return id.trim().startsWith("ypub") ? "nested" : "native";
}

// 添加账户的录入字段与提交(A4 从 add-account-sheet 抽出,供 AddAccountModal 复用)。connector-driven 创建(#55):
// 字段组件按 connector.account.creds 的 key 写入 values,原样透传给统一 createAccount(校验/加密/落库全在服务端
// 按 connectorId 驱动)。manual 选币用 TokenCombobox(内联下推,取代旧 TokenPicker 浮层)。
async function submitAccount(
  connectorId: ConnectorId,
  label: string,
  values: Record<string, string>,
  portfolioId: string | undefined,
) {
  // portfolioId:新账户落在当前选中的 Portfolio(ADR 0033);缺省(= 看默认)则服务端落默认。
  return createAccount({ data: { connectorId, label, values, portfolioId } });
}

// manual 的字段:富控件(TokenCombobox 选币联动 symbol + 票 + autofill 单价 / 数字)。
// 找不到的币可切"手动输入 symbol"(不关联,票为空)。
// manual 的 account.creds 就是单个 `tokens`(ADR 0017)→ 本地维护首 token 标量,序列化成 `values.tokens`
// (单元素 JSON,数字留字符串由 manualToken validator coerce)提交,服务端不再从标量拼装。
function ManualFields({
  setValues,
}: {
  setValues: (fn: (v: Record<string, string>) => Record<string, string>) => void;
}) {
  const t = useTranslations("Accounts");
  const [picked, setPicked] = useState<TokenOption | null>(null);
  const [manualMode, setManualMode] = useState(false);
  // 取价 + 竞态守卫 + busy 都来自这一份共享 hook(#428 片 5)。
  // 这里以前自己抄了一遍同样的 `reqRef` 守卫,与 use-token-price.ts 各存一份 —— 现在只有一份。
  const { fetchPrice, cancel: cancelPriceFetch, busy: priceBusy } = useTokenPrice();
  // 首 token 的本地标量;经 effect 序列化进 values.tokens(不在 setState updater 里做副作用)。
  const [tok, setTok] = useState({ symbol: "", amount: "", unitPrice: "", ticket: "" });
  const patch = (p: Partial<typeof tok>) => setTok((prev) => ({ ...prev, ...p }));

  // tok → values.tokens(纯序列化见 manualTokensJson)。副作用放 effect,不在 setState updater 里。
  useEffect(() => {
    setValues(() => ({ tokens: manualTokensJson(tok) }));
  }, [tok, setValues]);

  // 选中币:填 symbol + 票,并回填 unitPrice(用户可改;竞态守卫)。
  // 票原样搬运 —— 组件不解释它,提交时随 `tokens` JSON 一起交回服务端。
  async function onPick(token: TokenOption | null) {
    setPicked(token);
    if (!token) {
      cancelPriceFetch(); // 作废还在飞的取价,否则它回来会往空掉的框里填数
      patch({ symbol: "", ticket: "", unitPrice: "" });
      return;
    }
    const { ticket } = token;
    patch({ symbol: token.symbol.toUpperCase(), ticket });
    // 下拉里已经显示了价(SWR 刷来的 / 默认列自带的)→ 直接用它回填,零延迟、就是用户点的那个数。
    if (token.price != null) {
      cancelPriceFetch();
      patch({ unitPrice: String(token.price) });
      return;
    }
    // 没有显示价(那行本来就是 `—`,比如刷价失败)→ 才回源现取一次兜底。
    await fetchPrice(ticket, (unitPrice) => patch({ unitPrice: String(unitPrice) }));
  }

  // 转去自定义 symbol(未收录资产):它没有市价 —— 清掉之前自动填的单价让用户自己填,
  // 顺带作废还在飞的取价(否则它回来会把单价又填上)、清票与已选项。
  function enterManual(symbol: string) {
    cancelPriceFetch();
    setPicked(null);
    setManualMode(true);
    patch({ symbol, ticket: "", unitPrice: "" });
  }

  // 转回搜索:清掉自定义 symbol 与单价,回到干净的选币态(重新选中会再自动填价)。
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

// 通用字段(onchain/exchange/perp):按 credentialSpecs 渲染(secret→password,其余 text);label 走 Inputs i18n。
// 两用:加账户(默认 idPrefix "add",无 hint)与补录(A3,idPrefix "cred" + hint = credsSafe,semi 字段展示
// "记录的 X:abc…xyz" 供识别)—— 一条字段渲染路径。hint 缺省 → 无提示行,加账户行为不变。
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
  hint?: Record<string, string>; // safeView 投影:semi 打码片段(补录时识别用)
}) {
  const ti = useTranslations("Inputs");
  const ta = useTranslations("Accounts");
  return (
    <>
      {specs.map((s) => {
        // 仅 semi 字段有可识别的打码片段(public 已知不问、secret 无投影);展示"记录的 X:片段"。
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
              required={s.type !== "public" || s.key === "address"}
              // secret 用 new-password:Chrome 对 password 框忽略 autoComplete="off",会回填本站登录账号/密码;
              // 标成"新密码"既不回填,也打断"前一个文本框=用户名"的登录表单配对,连带 API Key 也不再被填。
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
  const { selectedId, defaultId } = usePortfolio();
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const mutation = useMutation({
    // 落在当前选中的 Portfolio;看默认时不传(服务端本就落默认),省一次多余归属重写。
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
