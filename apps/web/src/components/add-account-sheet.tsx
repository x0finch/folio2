import type { ConnectorId } from "@folio/connectors";
import type { TokenInfo } from "@folio/tokens";
import {
  Button,
  Drawer,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatefulButton,
} from "@folio/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { cloneElement, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import {
  BTC_SCRIPT_OPTIONS,
  isBareXpub,
  isExtendedPubkey,
  recommendedScript,
} from "../lib/bitcoin-scripts";
import { CONNECTOR_OPTIONS } from "../lib/connectors";
import { createAccount } from "../lib/server/accounts";
import { getCredentialSpecs, type InputSpec } from "../lib/server/credentials";
import { syncOneAccount } from "../lib/server/sync";
import { tokenPrice } from "../lib/server/tokens";
import { useConnectorLabels } from "../lib/use-connector-labels";
import { TokenPicker } from "./token-picker";

// connector-driven 创建(#55):字段组件已按 connector.account.creds 的 key 写入 values,
// 这里只需原样透传给统一的 createAccount(校验/加密/落库全在服务端按 connectorId 驱动)。
async function submitAccount(
  connectorId: ConnectorId,
  label: string,
  values: Record<string, string>,
) {
  return createAccount({ data: { connectorId, label, values } });
}

// manual 的字段:富控件(TokenCombobox 选币联动 symbol+identifier+autofill 单价 / 数字 / 锁定勾选)。
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
              className="self-start text-xs text-muted-foreground underline"
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
            <TokenPicker
              value={picked}
              onChange={onPick}
              onManual={(q) => {
                setManualMode(true);
                setValues((v) => ({ ...v, symbol: q, identifier: "" }));
              }}
            />
            <button
              type="button"
              className="self-start text-xs text-muted-foreground underline"
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
        <p className="text-xs text-muted-foreground">
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
          <p className="text-xs text-muted-foreground">{ti("btcScriptHint")}</p>
        </div>
      )}
      {/* ypub/zpub:前缀已确定类型 → 只读展示,不必选。 */}
      {isExtendedPubkey(id) && !isBareXpub(id) && (
        <div className="flex flex-col gap-1.5">
          <Label>{ti("Address type")}</Label>
          <p className="text-sm text-muted-foreground">{detectedLabel}</p>
        </div>
      )}
    </>
  );
}

// 单个 connector 的录入表单。key={connectorId} 重挂 → 切 connector 自动清空本地态(不用 useEffect→setState)。
function AccountForm({
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
      className="mt-4 flex flex-col gap-4"
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
        <p className="text-sm text-destructive">
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

// 统一「添加账户」侧栏:分组 Select 切 connector → schema 驱动字段(manual 富控件)。
// triggerRender:自定义触发元素(账户页传 Fab);缺省用普通按钮。
export function AddAccountSheet({ triggerRender }: { triggerRender?: React.ReactElement } = {}) {
  const t = useTranslations("Accounts");
  const router = useRouter();
  const labelOf = useConnectorLabels();
  const [open, setOpen] = useState(false);
  const [connectorId, setConnectorId] = useState<ConnectorId>("manual");
  // 字段规格部署内静态 → 长 staleTime,几乎只取一次。
  const specsQuery = useQuery({
    queryKey: ["credentialSpecs"],
    queryFn: () => getCredentialSpecs(),
    staleTime: 60 * 60_000,
  });
  const specs = specsQuery.data?.[connectorId] ?? [];

  return (
    <>
      {cloneElement(triggerRender ?? <Button size="sm">{t("addAccount")}</Button>, {
        onClick: () => setOpen(true),
      })}
      <Drawer
        open={open}
        onOpenChange={setOpen}
        side="right"
        ariaLabel={t("addAccount")}
        className="w-full overflow-y-auto p-6 sm:max-w-md"
      >
        <div className="flex flex-col gap-1.5">
          <h2 className="text-lg font-semibold">{t("addAccount")}</h2>
          <p className="text-sm text-muted-foreground">{t("addAccountHint")}</p>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <Label>{t("accountType")}</Label>
          <Select value={connectorId} onValueChange={(v) => setConnectorId(v as ConnectorId)}>
            <SelectTrigger>
              {/* 显示选中 connector 的展示名(label,由 SelectItem 注册),而非裸 connectorId 值。 */}
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* 固定分组列表(写死的 group 标题 + 选项);顺序即 CONNECTOR_OPTIONS 的定义序。 */}
              {CONNECTOR_OPTIONS.map((g) => (
                <div key={g.group}>
                  <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                    {g.group}
                  </div>
                  {g.options.map((ty) => (
                    <SelectItem key={ty} value={ty}>
                      {labelOf(ty)}
                    </SelectItem>
                  ))}
                </div>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* key={connectorId} 重挂 → 切 connector 清空字段态 */}
        <AccountForm
          key={connectorId}
          connectorId={connectorId}
          specs={specs}
          onDone={(newId) => {
            setOpen(false);
            router.invalidate(); // 新账户即时出现(此刻空值)
            // 方案 A:后台自动同步新账户 → 完成再 invalidate 填充;不阻塞、失败静默(创建流已校验凭据)。
            void syncOneAccount({ data: { accountId: newId } })
              .then(() => router.invalidate())
              .catch(() => {});
          }}
        />
      </Drawer>
    </>
  );
}
