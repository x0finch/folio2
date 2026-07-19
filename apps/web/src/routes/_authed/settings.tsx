import {
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Label,
  MorphingModal,
  Separator,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@folio/ui";
import { createFileRoute, getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { CurrencySwitcher } from "../../components/currency-switcher";
import { type AccountUser, accountIdentity } from "../../lib/account-identity";
import { signOut } from "../../lib/auth-client";
import { LOCALE_COOKIE } from "../../lib/i18n/detect";
import { getKeyStatus, getValuationSettings, setValuationMode } from "../../lib/server/settings";
import { type Theme, useTheme } from "../../lib/theme";

const authedApi = getRouteApi("/_authed");

export const Route = createFileRoute("/_authed/settings")({
  loader: async () => {
    const [status, valuation] = await Promise.all([getKeyStatus(), getValuationSettings()]);
    return { status, valuation };
  },
  component: Settings,
});

// 全局 provider key(品牌名不翻译);env 名是 getKeyStatus 返回的 key。
const PROVIDER_KEYS = [
  { env: "ZERION_API_KEY", label: "Zerion (EVM)" },
  { env: "COINSTATS_API_KEY", label: "CoinStats (Solana / Sui / Cosmos)" },
] as const;

// 设置页(S1,#112):外观 / 账户 / 币种 / 登出全集中于此(外壳退回纯导航 + 身份)。
// 卡片顺序(grill):账户 → 外观 → Provider key → 估值 → 数据。
function Settings() {
  const { status, valuation } = Route.useLoaderData();
  const { user } = authedApi.useRouteContext();
  return (
    <div className="flex flex-col gap-6">
      <AccountCard user={user} />
      <AppearanceCard />
      <ProviderKeysCard status={status} />
      <ValuationCard mode={valuation.valuationMode} />
      <DataCard />
    </div>
  );
}

// 标签左、控件右对齐的设置行(单行 justify-between)。
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  );
}

// 账户卡(置顶):身份行 + 登出;登出走 MorphingModal 二次确认(grill Q5)。
function AccountCard({ user }: { user: AccountUser }) {
  const t = useTranslations("Settings");
  const ts = useTranslations("Sidebar");
  const tc = useTranslations("Common");
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const id = accountIdentity(user);
  const secondary = id.secondary.kind === "email" ? id.secondary.value : ts("selfHosted");

  async function doSignOut() {
    await signOut();
    navigate({ to: "/login" });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("account")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-foreground text-sm">
              {id.initial}
            </div>
            <div className="min-w-0 leading-tight">
              <div className="truncate font-medium text-sm">{id.primary}</div>
              <div className="truncate text-muted-foreground text-sm">{secondary}</div>
            </div>
          </div>
          <Button variant="outline" onClick={() => setConfirmOpen(true)}>
            <LogOut className="size-4" />
            {t("signOut")}
          </Button>
        </div>
      </CardContent>

      <MorphingModal viewId={confirmOpen ? "signout" : null} onClose={() => setConfirmOpen(false)}>
        <div className="text-left">
          <p className="font-semibold text-base">{t("signOutConfirmTitle")}</p>
          <p className="mt-1.5 text-muted-foreground text-sm">{t("signOutConfirmBody")}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button variant="destructive" onClick={doSignOut}>
              {t("signOut")}
            </Button>
          </div>
        </div>
      </MorphingModal>
    </Card>
  );
}

// 外观卡:主题(三态 segmented)· 语言(中/EN segmented)· 币种(Select)。
// segmented = beUI Tabs(pill,仅 list,不挂 panel);中/EN 是语言自称,不本地化。
function AppearanceCard() {
  const t = useTranslations("Settings");
  const router = useRouter();
  const locale = useLocale();
  const { theme, setTheme } = useTheme();
  // 主题存于 localStorage(客户端专属):SSR 只能得 "system",而 hydration 时 useTheme 已读到真实值
  // → 首帧不一致会触发 hydration mismatch + pill 硬跳。挂载前统一按 "system" 渲染选中态(与 SSR 齐),
  // 挂载后再切真实值,pill 借 layoutId 平滑滑到位。语言走 cookie/SSR 一致,无需此处理。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const themeValue = mounted ? theme : "system";

  function setLocale(next: string) {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000`;
    router.invalidate();
  }

  return (
    // overflow-visible:覆盖 Card 默认的 overflow-hidden,否则币种 Select 的弹层(非 portal,
    // absolute 定位)会被卡片裁掉(#112 目视修正)。
    <Card className="overflow-visible">
      <CardHeader>
        <CardTitle>{t("appearance")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SettingRow label={t("theme")}>
          {/* 轨道底做成内凹:亮色卡是白,用 bg-muted(浅灰可见);暗色用 bg-background(比卡片更深)。保留默认 p-1。 */}
          <Tabs value={themeValue} onValueChange={(v) => setTheme(v as Theme)} variant="pill">
            <TabsList className="bg-muted dark:bg-background">
              <TabsTrigger value="light">{t("themeLight")}</TabsTrigger>
              <TabsTrigger value="dark">{t("themeDark")}</TabsTrigger>
              <TabsTrigger value="system">{t("themeSystem")}</TabsTrigger>
            </TabsList>
          </Tabs>
        </SettingRow>
        <SettingRow label={t("language")}>
          <Tabs value={locale} onValueChange={setLocale} variant="pill">
            <TabsList className="bg-muted dark:bg-background">
              <TabsTrigger value="zh">中</TabsTrigger>
              <TabsTrigger value="en">EN</TabsTrigger>
            </TabsList>
          </Tabs>
        </SettingRow>
        <SettingRow label={t("currency")}>
          <CurrencySwitcher />
        </SettingRow>
      </CardContent>
    </Card>
  );
}

function ProviderKeysCard({ status }: { status: Record<string, boolean> }) {
  const t = useTranslations("Settings");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("providerKeys")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {PROVIDER_KEYS.map((k) => (
            <li key={k.env} className="flex items-center justify-between">
              <span>{k.label}</span>
              <span className={status[k.env] ? "text-foreground" : "text-muted-foreground"}>
                {status[k.env] ? t("configured") : t("notConfigured")}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// 估值模式(Phase 3,#82):勾选 = source-first(统一采用市场源价);不勾 = self-first(默认)。
// 切换即写 user_settings + invalidate → 主页/图表现推立即改(历史冻结,无需重 sync)。
function ValuationCard({ mode }: { mode: "self-first" | "source-first" }) {
  const router = useRouter();
  const t = useTranslations("Settings");
  const [sourceFirst, setSourceFirst] = useState(mode === "source-first");
  const [busy, setBusy] = useState(false);

  async function onToggle(checked: boolean) {
    setSourceFirst(checked); // 乐观更新
    setBusy(true);
    try {
      await setValuationMode({ data: { mode: checked ? "source-first" : "self-first" } });
      await router.invalidate(); // 刷新总览/图表读路径
    } catch {
      setSourceFirst(!checked); // 回滚
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("valuation")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="valuation-source-first"
            checked={sourceFirst}
            disabled={busy}
            onCheckedChange={onToggle}
          />
          <Label htmlFor="valuation-source-first">{t("useSourcePrice")}</Label>
        </div>
        <p className="text-sm text-muted-foreground">{t("valuationHint")}</p>
      </CardContent>
    </Card>
  );
}

// 数据卡(合一):导出段 + 分隔线 + 导入段。复用现有 /api/export、/api/import 路由。
// 导入文案沿用 Accounts 命名空间的 import* 键(与账户页导入同源)。
function DataCard() {
  const router = useRouter();
  const t = useTranslations("Settings");
  const ta = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const inputRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMsg(null);
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/import", { method: "POST", body: file });
      if (!res.ok) throw new Error(await res.text());
      const { imported } = (await res.json()) as {
        imported: { accounts: number; groups: number; snapshots: number };
      };
      setMsg(
        ta("imported", {
          accounts: imported.accounts,
          groups: imported.groups,
          snapshots: imported.snapshots,
        }),
      );
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("data")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <p className="min-w-0 text-sm text-muted-foreground">{t("exportHint")}</p>
          <a
            href="/api/export"
            download
            className={buttonVariants({
              variant: "outline",
              className: "shrink-0 whitespace-nowrap",
            })}
          >
            {t("exportData")}
          </a>
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-4">
            <p className="min-w-0 text-sm text-muted-foreground">{ta("importHint")}</p>
            <input
              ref={inputRef}
              type="file"
              accept=".ndjson,application/x-ndjson,application/json"
              className="hidden"
              onChange={onImportFile}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              className="shrink-0 whitespace-nowrap"
              onClick={() => inputRef.current?.click()}
            >
              {busy ? tc("verifying") : ta("importBtn")}
            </Button>
          </div>
          {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
