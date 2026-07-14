import { toast } from "@folio/ui";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { syncOneAccount } from "../server/sync";
import { orchestrateSync } from "../sync-orchestrator";

// 账户同步的共享逻辑(PageHeader SyncStatus 复用):并发(≤3)逐个 syncOneAccount,
// 进度/成功/失败统一走 sonner toast(D07 收尾:去掉页面内文字反馈),完成后 invalidate。
export function useAccountSync(accounts: { id: string; label: string }[]) {
  const t = useTranslations("Accounts");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const disabled = busy || accounts.length === 0;

  async function sync() {
    if (disabled) return;
    setBusy(true);
    const id = toast.loading(
      t("syncingProgress", { done: 0, total: accounts.length, current: "…" }),
    );
    const worker = async (accId: string) => {
      const r = await syncOneAccount({ data: { accountId: accId } });
      // skipped(缺凭据)不算失败;其余非 ok → 抛错供编排收集。
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

  return { busy, disabled, sync };
}
