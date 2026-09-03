import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
} from "@folio/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "use-intl";
import { CurrencySwitcher } from "@/components/currency-switcher";
import { type Theme, useMountedTheme } from "@/lib/hooks/use-theme";
import { invalidateFor } from "@/lib/queries/refresh";
import { valuationSettingsQuery } from "@/lib/queries/settings";
import { setLocalePreference } from "@/lib/server/preferences";
import { updatePrivacySettings } from "@/lib/server/settings";
import { SettingRow } from "./setting-row";

// 外观卡:主题(三态 segmented)· 语言(中/EN segmented)· 币种(Select)。
// segmented = beUI Tabs(pill,仅 list,不挂 panel);中/EN 是语言自称,不本地化。

export function AppearanceCard() {
  const t = useTranslations("Settings");
  const queryClient = useQueryClient();
  const locale = useLocale();
  // 选中态用 useMountedTheme(SSR 安全):挂载前按 "system" 渲染避免 hydration mismatch + pill 硬跳,
  // 挂载后借 layoutId 平滑滑到位。语言走 cookie/SSR 一致,无需此处理。
  const { theme: themeValue, setTheme } = useMountedTheme();

  const localeMut = useMutation({
    mutationFn: (next: string) => setLocalePreference({ data: { locale: next } }),
    onSuccess: () => invalidateFor(queryClient, "preference.locale"),
  });

  function setLocale(next: string) {
    if (next === locale) return;
    localeMut.mutate(next);
  }

  // 隐藏余额(FOL-75,ADR 0052)。开关来自 user_settings(与估值口径同一份读,见 settings.ts)。
  const settingsQuery = useQuery(valuationSettingsQuery());
  const hideBalances = settingsQuery.data?.hideBalances;
  const hideMut = useMutation({
    mutationFn: (next: boolean) => updatePrivacySettings({ data: { hideBalances: next } }),
    // **乐观 + 不 invalidate**:立刻把共享的 user_settings 读缓存翻过来,开关即时响应、隐私 Provider
    // (读同一份)立刻跟随;privacy 不驱动任何计算,refetch 整份读只会白白触发一次总览重算。
    onMutate: async (next) => {
      const key = valuationSettingsQuery().queryKey;
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData(key);
      if (prev) queryClient.setQueryData(key, { ...prev, hideBalances: next });
      return { prev, key };
    },
    onError: (_e, _next, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(ctx.key, ctx.prev);
      toast.error(t("hideBalancesError"));
    },
  });

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
        <div className="flex flex-col gap-1">
          <SettingRow label={t("hideBalances")}>
            <Switch
              // 读到之前先按关渲染(禁用);fail-closed 只关乎「屏幕上遮不遮」,开关本身按缺省画即可。
              checked={hideBalances ?? false}
              disabled={hideBalances == null}
              onCheckedChange={(next) => hideMut.mutate(next)}
              ariaLabel={t("hideBalances")}
            />
          </SettingRow>
          <p className="text-muted-foreground text-sm">{t("hideBalancesHint")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
