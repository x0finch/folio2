import { Fab } from "@folio/ui";
import { RefreshCw } from "lucide-react";
import { useTranslations } from "use-intl";
import { useAccountSync } from "../lib/use-account-sync";

// 悬浮同步钮(复刻 folio-old overview FAB):并发同步 + toast 进度,逻辑走共享 useAccountSync。
export function SyncFab({ accounts }: { accounts: { id: string; label: string }[] }) {
  const t = useTranslations("Accounts");
  const { busy, disabled, sync } = useAccountSync(accounts);

  return (
    <Fab
      position="bottom-right"
      icon={<RefreshCw className={busy ? "animate-spin" : ""} />}
      onClick={sync}
      disabled={disabled}
      aria-label={t("syncNow")}
    />
  );
}
