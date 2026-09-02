import { Button, Card, CardContent, CardHeader, CardTitle } from "@folio/ui";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { applyUpdate, checkForUpdate, useUpdateAvailable } from "@/lib/pwa/service-worker";
import { SettingRow } from "./setting-row";

// 更新卡(ADR 0051 / FOL-66):toast 之外那个「随时能回去更新」的固定入口 —— toast 会自动消失、
// 可能错过。有 waiting 新版 → 显「有新版本 · 更新」,点即走换版机制(亮回「更新中」splash → reload);
// 无则显「已是最新」,点一下手动 registration.update() 主动检查。
export function UpdateCard() {
  const t = useTranslations("Update");
  const available = useUpdateAvailable();
  const [checking, setChecking] = useState(false);

  async function onCheck() {
    setChecking(true);
    try {
      await checkForUpdate();
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("cardTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <SettingRow label={available ? t("available") : t("upToDate")}>
          {available ? (
            <Button
              type="button"
              size="sm"
              className="shrink-0 whitespace-nowrap"
              onClick={() => applyUpdate()}
            >
              {t("update")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={checking}
              className="shrink-0 whitespace-nowrap"
              onClick={onCheck}
            >
              {checking ? t("checking") : t("check")}
            </Button>
          )}
        </SettingRow>
      </CardContent>
    </Card>
  );
}
