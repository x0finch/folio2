import { Fab, toast } from "@folio/ui";
import { useRouter } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { syncOneAccount } from "../lib/server/sync";
import { orchestrateSync } from "../lib/sync-orchestrator";

// 悬浮同步钮(复刻 folio-old overview FAB):并发(≤3)逐个 syncOneAccount,进度经 sonner toast 实时更新。
// 复用已单测的 orchestrateSync;成功/失败以 toast 反馈,完成后 invalidate 刷新。
export function SyncFab({ accounts }: { accounts: { id: string; label: string }[] }) {
  const t = useTranslations("Accounts");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const disabled = busy || accounts.length === 0;

  async function onSync() {
    if (disabled) return;
    setBusy(true);
    const id = toast.loading(
      t("syncingProgress", { done: 0, total: accounts.length, current: "…" }),
    );
    const worker = async (accId: string) => {
      const r = await syncOneAccount({ data: { accountId: accId } });
      if (!r.ok && !r.skipped) throw new Error(r.error ?? "sync failed");
    };
    try {
      const final = await orchestrateSync(
        accounts.map((a) => ({ accountId: a.id, label: a.label })),
        worker,
        {
          concurrency: 3,
          onProgress: (p) =>
            toast.loading(
              t("syncingProgress", {
                done: p.done,
                total: p.total,
                current: p.inFlight.join(", ") || "…",
              }),
              { id },
            ),
        },
      );
      if (final.failures.length > 0) {
        toast.error(
          t("syncFailed", {
            count: final.failures.length,
            details: final.failures.map((f) => `${f.label}: ${f.error}`).join("; "),
          }),
          { id },
        );
      } else {
        toast.success(t("synced", { count: final.total }), { id });
      }
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Fab
      position="bottom-right"
      icon={<RefreshCw className={busy ? "animate-spin" : ""} />}
      onClick={onSync}
      disabled={disabled}
      aria-label={t("syncNow")}
    />
  );
}
