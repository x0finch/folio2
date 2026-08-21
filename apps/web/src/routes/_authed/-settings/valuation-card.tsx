import { Card, CardContent, CardHeader, CardTitle, Checkbox, Label, Skeleton } from "@folio/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { invalidateFor } from "@/lib/queries/refresh";
import { valuationSettingsQuery } from "@/lib/queries/settings";
import { updateValuationSettings } from "@/lib/server/settings";

const KEEP_TRYING = { retry: true as const };

// 估值模式(Phase 3,#82):勾选 = source-first(统一采用市场源价);不勾 = self-first(默认)。
// 切换即写 user_settings + invalidate → 主页/图表现推立即改(历史冻结,无需重 sync)。
export function ValuationCard() {
  const queryClient = useQueryClient();
  const t = useTranslations("Settings");
  const settingsQuery = useQuery({ ...valuationSettingsQuery(), ...KEEP_TRYING });
  const toggle = useMutation({
    mutationFn: (checked: boolean) =>
      updateValuationSettings({ data: { mode: checked ? "source-first" : "self-first" } }),
    onSuccess: () => invalidateFor(queryClient, "settings.valuation"),
  });
  const mode = settingsQuery.data?.valuationMode;
  const body =
    mode == null ? (
      <Skeleton className="h-5 w-64" />
    ) : (
      <>
        <div className="flex items-center gap-2">
          <Checkbox
            id="valuation-source-first"
            checked={toggle.isPending ? toggle.variables : mode === "source-first"}
            disabled={toggle.isPending}
            onCheckedChange={(checked) => toggle.mutate(checked)}
          />
          <Label htmlFor="valuation-source-first">{t("useSourcePrice")}</Label>
        </div>
        <p className="text-sm text-muted-foreground">{t("valuationHint")}</p>
      </>
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("valuation")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">{body}</CardContent>
    </Card>
  );
}
