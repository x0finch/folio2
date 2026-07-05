import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@folio/ui";
import { useRouter } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { syncOneAccount } from "../lib/server/sync";
import { orchestrateSync, type SyncProgress } from "../lib/sync-orchestrator";

// 复用的同步图标按钮(首页 + 账户页)。点击后客户端并发(≤3)逐个 syncOneAccount,tooltip 实时进度。
// 成功静默(数字/时间随 invalidate 刷新),失败在 tooltip + 按钮旁小字兜底。设计见 PRD/issue 02。
export function SyncButton({
  accounts,
  lastSyncedAt,
}: {
  accounts: { id: string; label: string }[];
  lastSyncedAt?: number | null;
}) {
  const t = useTranslations("Accounts");
  const format = useFormatter();
  const router = useRouter();
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [failures, setFailures] = useState<SyncProgress["failures"]>([]);
  const busy = progress != null;
  const disabled = busy || accounts.length === 0;

  async function onSync() {
    if (disabled) return;
    setFailures([]);
    const worker = async (id: string) => {
      const r = await syncOneAccount({ data: { accountId: id } });
      // skipped(缺凭据)不算失败,与账户页现有口径一致;其余非 ok → 抛错供编排收集。
      if (!r.ok && !r.skipped) throw new Error(r.error ?? "sync failed");
    };
    try {
      const final = await orchestrateSync(
        accounts.map((a) => ({ accountId: a.id, label: a.label })),
        worker,
        { concurrency: 3, onProgress: setProgress },
      );
      setFailures(final.failures);
      await router.invalidate();
    } finally {
      setProgress(null);
    }
  }

  const failMsg =
    failures.length > 0
      ? t("syncFailed", {
          count: failures.length,
          details: failures.map((f) => `${f.label}: ${f.error}`).join("; "),
        })
      : null;
  const tip =
    progress != null
      ? t("syncingProgress", {
          done: progress.done,
          total: progress.total,
          current: progress.inFlight.join(", ") || "…",
        })
      : (failMsg ??
        (lastSyncedAt
          ? t("lastSyncedAt", { when: format.relativeTime(new Date(lastSyncedAt)) })
          : t("neverSynced")));

  return (
    <div className="flex items-center gap-2">
      {failMsg && !busy && (
        <span className="text-xs text-destructive">
          {t("syncFailed", { count: failures.length, details: "" })}
        </span>
      )}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon"
                variant="outline"
                onClick={onSync}
                disabled={disabled}
                aria-label={t("syncNow")}
              >
                <RefreshCw className={busy ? "animate-spin" : ""} />
              </Button>
            }
          />
          <TooltipContent>{tip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
