import type { AccountType } from "@folio/balances";
import type { TokenInfo } from "@folio/tokens";
import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  StatefulButton,
} from "@folio/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { type OnchainType, TYPE_GROUPS, typeLabel } from "../lib/account-types";
import {
  createExchangeAccount,
  createManualAccount,
  createOnchainAccount,
  createPerpAccount,
} from "../lib/server/accounts";
import { getCredentialSpecs, type InputSpec } from "../lib/server/credentials";
import { syncOneAccount } from "../lib/server/sync";
import { tokenPrice } from "../lib/server/tokens";
import { TokenCombobox } from "./token-combobox";

// 按类型派发到对应 server fn(键适配:通用字段 identifier→address 等)。统一成单个 createAccount 留 follow-up。
async function submitAccount(type: AccountType, label: string, values: Record<string, string>) {
  if (type === "manual") {
    return createManualAccount({
      data: {
        label,
        symbol: values.symbol ?? "",
        amount: values.amount ?? "",
        unitPrice: values.unitPrice ?? "",
        identifier: values.identifier || undefined,
        fixed: values.fixed === "1",
      },
    });
  }
  if (type === "exchange_binance" || type === "exchange_okx") {
    return createExchangeAccount({
      data: {
        type,
        label,
        apiKey: values.apiKey ?? "",
        secret: values.secret ?? "",
        passphrase: values.passphrase || undefined,
      },
    });
  }
  if (type === "perp_hyperliquid") {
    return createPerpAccount({ data: { type, label, address: values.identifier ?? "" } });
  }
  // 其余为链上类型(注册表只暴露已实现的 onchain_*)。
  return createOnchainAccount({
    data: { type: type as OnchainType, label, address: values.identifier ?? "" },
  });
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
              onChange={(e) => set("symbol", e.target.value)}
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
          onChange={(e) => set("amount", e.target.value)}
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
          onChange={(e) => set("unitPrice", e.target.value)}
          placeholder="0.0"
        />
        <p className="text-xs text-muted-foreground">
          {priceBusy ? t("fetchingPrice") : t("unitPriceHint")}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="m-fixed"
            checked={values.fixed === "1"}
            onCheckedChange={(c) => set("fixed", c === true ? "1" : "")}
          />
          <Label htmlFor="m-fixed">{t("fixedLabel")}</Label>
        </div>
        <p className="text-xs text-muted-foreground">{t("fixedHint")}</p>
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
            required={s.type !== "public" || s.key === "identifier"}
            // secret 用 new-password:Chrome 对 password 框忽略 autoComplete="off",会回填本站登录账号/密码;
            // 标成"新密码"既不回填,也打断"前一个文本框=用户名"的登录表单配对,连带 API Key 也不再被填。
            autoComplete={s.type === "secret" ? "new-password" : "off"}
            value={values[s.key] ?? ""}
            placeholder={s.desc ? ti(s.desc) : undefined}
            onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.value }))}
          />
        </div>
      ))}
    </>
  );
}

// 单类型的录入表单。key={type} 重挂 → 切类型自动清空本地态(不用 useEffect→setState)。
function AccountForm({
  type,
  specs,
  onDone,
}: {
  type: AccountType;
  specs: InputSpec[];
  onDone: (accountId: string) => void;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const mutation = useMutation({
    mutationFn: () => submitAccount(type, label, values),
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
          onChange={(e) => setLabel(e.target.value)}
          placeholder={
            type === "manual" ? t("manualLabelPlaceholder") : t("walletLabelPlaceholder")
          }
        />
      </div>
      {type === "manual" ? (
        <ManualFields values={values} setValues={setValues} />
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

// 统一「添加账户」侧栏:分组 Select 切类型 → schema 驱动字段(manual 富控件)。
// triggerRender:自定义触发元素(账户页传 Fab);缺省用普通按钮。
export function AddAccountSheet({ triggerRender }: { triggerRender?: React.ReactElement } = {}) {
  const t = useTranslations("Accounts");
  const tCat = useTranslations("Accounts");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<AccountType>("manual");
  // 字段规格部署内静态 → 长 staleTime,几乎只取一次。
  const specsQuery = useQuery({
    queryKey: ["credentialSpecs"],
    queryFn: () => getCredentialSpecs(),
    staleTime: 60 * 60_000,
  });
  const specs = specsQuery.data?.[type] ?? [];

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={triggerRender ?? <Button size="sm">{t("addAccount")}</Button>} />
      <SheetContent side="right" className="w-full overflow-y-auto p-6 sm:max-w-md">
        <SheetHeader className="p-0">
          <SheetTitle>{t("addAccount")}</SheetTitle>
          <SheetDescription>{t("addAccountHint")}</SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex flex-col gap-2">
          <Label htmlFor="add-type">{t("accountType")}</Label>
          <Select value={type} onValueChange={(v) => setType(v as AccountType)}>
            <SelectTrigger id="add-type">
              {/* 显示选中类型的展示名(label),而非裸 type 值。 */}
              <SelectValue>{(v: AccountType) => typeLabel(v)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {TYPE_GROUPS.map((g) => (
                <SelectGroup key={g.category}>
                  <SelectLabel>{tCat(`cat_${g.category}`)}</SelectLabel>
                  {g.types.map((ty) => (
                    <SelectItem key={ty} value={ty}>
                      {typeLabel(ty)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* key={type} 重挂 → 切类型清空字段态 */}
        <AccountForm
          key={type}
          type={type}
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
      </SheetContent>
    </Sheet>
  );
}
