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
  toast,
} from "@folio/ui";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";
import { Fingerprint, LogOut } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { CurrencySwitcher } from "../../components/currency-switcher";
import { useMountedTheme } from "../../hooks/use-theme";
import { type AccountUser, accountIdentity } from "../../lib/account-identity";
import { authClient, signOut } from "../../lib/auth-client";
import { LOCALE_COOKIE } from "../../lib/i18n/detect";
import { importData } from "../../lib/import-data";
import {
  getDataStats,
  getProviderKeyStatus,
  getValuationSettings,
  updateValuationSettings,
} from "../../lib/server/settings";
import type { Theme } from "../../lib/theme";

const authedApi = getRouteApi("/_authed");

export const Route = createFileRoute("/_authed/settings")({
  loader: async () => {
    const [status, valuation, dataStats] = await Promise.all([
      getProviderKeyStatus(),
      getValuationSettings(),
      getDataStats(),
    ]);
    return { status, valuation, dataStats };
  },
  component: Settings,
});

// 全局 provider key(品牌名不翻译);env 名是 getProviderKeyStatus 返回的 key。
// EVM 默认走 Rabby(不需要 key,所以不在这张表里);Zerion 是可选备源。
const PROVIDER_KEYS = [
  { env: "ZERION_API_KEY", label: "Zerion (EVM 备源,可不配)" },
  { env: "COINSTATS_API_KEY", label: "CoinStats (Solana / Sui / Cosmos)" },
] as const;

// 设置页(S1,#112):外观 / 账户 / 币种 / 登出全集中于此(外壳退回纯导航 + 身份)。
// 卡片顺序(grill):账户 → 外观 → Provider key → 估值 → 数据。
function Settings() {
  const { status, valuation, dataStats } = Route.useLoaderData();
  const { user } = authedApi.useRouteContext();
  return (
    <div className="flex flex-col gap-6">
      <AccountCard user={user} />
      <PasskeysCard />
      <AppearanceCard />
      <ProviderKeysCard status={status} />
      <ValuationCard mode={valuation.valuationMode} />
      <DataCard hasData={dataStats.hasData} />
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

// Passkey 卡(#283):注册入口 —— 用 Face ID / Touch ID / 安全钥匙登录(首因子,与密码并列)。
// 仅浏览器支持 WebAuthn 时露注册按钮;不支持给一行说明。凭据列表/删除/重命名见片2(#284)。
function PasskeysCard() {
  const t = useTranslations("Settings");
  const tc = useTranslations("Common");
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && !!window.PublicKeyCredential);
  }, []);

  async function onAdd() {
    setBusy(true);
    try {
      const res = await authClient.passkey.addPasskey();
      if (res?.error) {
        toast.error(res.error.message ?? t("passkeyAddFailed"));
        return;
      }
      toast.success(t("passkeyAdded"));
    } catch {
      toast.error(t("passkeyAddFailed")); // 用户取消 / 认证器失败等
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("passkeys")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {supported ? t("passkeysHint") : t("passkeyUnsupported")}
        </p>
        {supported && (
          <div className="flex justify-end">
            <Button variant="outline" disabled={busy} onClick={onAdd}>
              <Fingerprint className="size-4" />
              {busy ? tc("verifying") : t("addPasskey")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// 外观卡:主题(三态 segmented)· 语言(中/EN segmented)· 币种(Select)。
// segmented = beUI Tabs(pill,仅 list,不挂 panel);中/EN 是语言自称,不本地化。
function AppearanceCard() {
  const t = useTranslations("Settings");
  const router = useRouter();
  const locale = useLocale();
  // 选中态用 useMountedTheme(SSR 安全):挂载前按 "system" 渲染避免 hydration mismatch + pill 硬跳,
  // 挂载后借 layoutId 平滑滑到位。语言走 cookie/SSR 一致,无需此处理。
  const { theme: themeValue, setTheme } = useMountedTheme();

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
      await updateValuationSettings({ data: { mode: checked ? "source-first" : "self-first" } });
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
function DataCard({ hasData }: { hasData: boolean }) {
  const router = useRouter();
  const t = useTranslations("Settings");
  const ta = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const inputRef = useRef<HTMLInputElement>(null);
  // 非空库导入是合并式(幂等,不翻倍),但先弹一道确认 —— 让用户明确知道是「并进已有数据」。
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  function clearInput() {
    if (inputRef.current) inputRef.current.value = "";
  }

  // 导入是「选了文件才发生一次的写」——用 useMutation 而非手搓 msg/error/busy 三个 state:
  // isPending 是单一事实源(直接接到 input/按钮的 disabled 上),连点两次也只跑一个;
  // 成功/失败各自的文案直接读 data/error,后回来的请求不会覆写前一条的状态(#241)。
  // 传输层抽在 lib/import-data(与仓里其它 mutation 一样调具名函数,不把 fetch 铺在组件里)。
  const importMutation = useMutation({
    mutationFn: importData,
    onSuccess: () => router.invalidate(), // 刷新列表读路径
    onSettled: clearInput, // 成败都清:让同一个文件能再选一次
  });

  function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (hasData) {
      setPendingFile(file); // 非空 → 先确认(见 MorphingModal),不立即导
      return;
    }
    importMutation.mutate(file); // 空库 → 直接导
  }

  function confirmImport() {
    const file = pendingFile;
    setPendingFile(null);
    if (file) importMutation.mutate(file);
  }

  function cancelImport() {
    setPendingFile(null);
    clearInput();
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
              disabled={importMutation.isPending}
              onChange={onImportFile}
            />
            <Button
              type="button"
              variant="outline"
              disabled={importMutation.isPending}
              className="shrink-0 whitespace-nowrap"
              onClick={() => inputRef.current?.click()}
            >
              {importMutation.isPending ? tc("verifying") : ta("importBtn")}
            </Button>
          </div>
          {importMutation.isSuccess && (
            <p className="text-sm text-muted-foreground">
              {ta("imported", {
                accounts: importMutation.data.imported.accounts,
                groups: importMutation.data.imported.groups,
                snapshots: importMutation.data.imported.snapshots,
              })}
            </p>
          )}
          {importMutation.isError && (
            <p className="text-sm text-destructive">{importMutation.error.message}</p>
          )}
        </div>
      </CardContent>

      <MorphingModal viewId={pendingFile ? "import-merge" : null} onClose={cancelImport}>
        <div className="text-left">
          <p className="font-semibold text-base">{t("importMergeTitle")}</p>
          <p className="mt-1.5 text-muted-foreground text-sm">{t("importMergeBody")}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={cancelImport}>
              {tc("cancel")}
            </Button>
            <Button onClick={confirmImport}>{t("importMergeConfirm")}</Button>
          </div>
        </div>
      </MorphingModal>
    </Card>
  );
}
