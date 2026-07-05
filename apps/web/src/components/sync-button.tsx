import { Button, Tooltip } from "@folio/ui";
import { RefreshCw } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";
import { useAccountSync } from "../lib/use-account-sync";

// 复用的同步图标按钮(首页 + 账户页)。点击后并发同步(逻辑走共享 useAccountSync,进度/结果走 toast);
// tooltip 兜底展示上次同步时间。设计见 PRD/issue 02。
export function SyncButton({
  accounts,
  lastSyncedAt,
}: {
  accounts: { id: string; label: string }[];
  lastSyncedAt?: number | null;
}) {
  const t = useTranslations("Accounts");
  const format = useFormatter();
  const { busy, disabled, sync } = useAccountSync(accounts);

  const tip = lastSyncedAt
    ? t("lastSyncedAt", { when: format.relativeTime(new Date(lastSyncedAt)) })
    : t("neverSynced");

  return (
    <Tooltip content={tip}>
      <Button
        size="icon"
        variant="outline"
        onClick={sync}
        disabled={disabled}
        aria-label={t("syncNow")}
      >
        <RefreshCw className={busy ? "animate-spin" : ""} />
      </Button>
    </Tooltip>
  );
}
