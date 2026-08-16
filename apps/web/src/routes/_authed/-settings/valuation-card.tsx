import { Card, CardContent, CardHeader, CardTitle, Checkbox, Label } from "@folio/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { invalidateFor } from "../../../lib/queries/refresh";
import { updateValuationSettings } from "../../../lib/server/settings";

// 估值模式(Phase 3,#82):勾选 = source-first(统一采用市场源价);不勾 = self-first(默认)。
// 切换即写 user_settings + invalidate → 主页/图表现推立即改(历史冻结,无需重 sync)。
// 导出供测试:勾选框的显示值现在是从 mutation 推出来的(在飞时看 variables,落地后看服务端那份),
// 「失败自动回到旧值」这条不再有一段显式回滚代码盯着 —— 值得单测钉住,见 tests/settings-valuation.test.tsx。
export function ValuationCard({ mode }: { mode: "self-first" | "source-first" }) {
  const queryClient = useQueryClient();
  const t = useTranslations("Settings");
  const toggle = useMutation({
    mutationFn: (checked: boolean) =>
      updateValuationSettings({ data: { mode: checked ? "source-first" : "self-first" } }),
    // 读时重估:历史不用重算,但总览 / 走势 / 账户持仓的现值全部按新口径重来。
    onSuccess: () => invalidateFor(queryClient, "settings.valuation"),
  });

  // 乐观显示不再需要本地 state 和回滚分支:在飞的时候显示这次点的值,落地(成或败)后交回服务端那份。
  // 失败自动回到旧值 —— 因为「旧值」从来就是 `mode`,没有第二份真相要维护。
  // isPending 一直保持到 onSuccess 里的 invalidate 也跑完,所以中间不会闪回旧值再跳到新值。
  const sourceFirst = toggle.isPending ? toggle.variables : mode === "source-first";

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
            disabled={toggle.isPending}
            onCheckedChange={(checked) => toggle.mutate(checked)}
          />
          <Label htmlFor="valuation-source-first">{t("useSourcePrice")}</Label>
        </div>
        <p className="text-sm text-muted-foreground">{t("valuationHint")}</p>
      </CardContent>
    </Card>
  );
}
