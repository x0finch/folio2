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
import { storeLocale } from "@/lib/i18n/locale-preference";
import { valuationSettingsQuery } from "@/lib/queries/settings";
import { updatePrivacySettings } from "@/lib/server/settings";
import { SettingRow } from "./setting-row";

// Language tabs show autonyms, which are not localized.
export function AppearanceCard() {
  const t = useTranslations("Settings");
  const queryClient = useQueryClient();
  const locale = useLocale();
  // useMountedTheme renders "system" until mounted to avoid a hydration mismatch.
  const { theme: themeValue, setTheme } = useMountedTheme();

  function setLocale(next: string) {
    if (next === locale) return;
    storeLocale(next);
  }

  const settingsQuery = useQuery(valuationSettingsQuery());
  const hideBalances = settingsQuery.data?.hideBalances;
  const hideMut = useMutation({
    mutationFn: (next: boolean) => updatePrivacySettings({ data: { hideBalances: next } }),
    // Optimistic, no invalidate: privacy drives no computation, so a refetch would only trigger a
    // pointless overview recompute.
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
    // overflow-visible: the currency Select popover isn't portaled and would be clipped.
    <Card className="overflow-visible">
      <CardHeader>
        <CardTitle>{t("appearance")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SettingRow label={t("theme")}>
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
        <SettingRow label={t("hideBalances")}>
          <Switch
            // Renders off (disabled) until loaded; fail-closed hiding is handled by the provider.
            checked={hideBalances ?? false}
            disabled={hideBalances == null}
            onCheckedChange={(next) => hideMut.mutate(next)}
            ariaLabel={t("hideBalances")}
          />
        </SettingRow>
      </CardContent>
    </Card>
  );
}
