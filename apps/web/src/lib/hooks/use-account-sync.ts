import { toast } from "@folio/ui";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { readSyncStream } from "../sync-stream";

// 账户同步的共享逻辑(PageHeader SyncStatus 复用):**一个请求**打到 /api/sync,服务端逐账户回结果,
// 这里边收边更新 toast 进度,完成后 invalidate。
//
// 以前是浏览器逐个调 syncAccount(并发 3)—— N 次往返,而且用户得一直停在页面上,关标签同步就断在半路。
// 现在服务端用 waitUntil 兜住整轮(见 routes/api/sync.ts),这条流只是观察窗:
// **关掉页面同步照样跑完**,只是看不到进度。
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
    // 服务端只回 accountId,展示名在这边。
    const labels = new Map(accounts.map((a) => [a.id, a.label]));
    try {
      const response = await fetch("/api/sync", { method: "POST" });
      const final = await readSyncStream(response, {
        total: accounts.length,
        labelOf: (accountId) => labels.get(accountId) ?? accountId,
        onProgress: (p) =>
          toast.loading(
            t("syncingProgress", {
              done: p.done,
              total: p.total ?? accounts.length,
              current: p.lastLabel ?? "…",
            }),
            { id },
          ),
      });
      if (final.failures.length > 0) {
        toast.error(
          t("syncFailed", {
            count: final.failures.length,
            details: final.failures
              .map((f) => `${labels.get(f.accountId) ?? f.accountId}: ${f.error}`)
              .join("; "),
          }),
          { id },
        );
      } else {
        toast.success(t("synced", { count: final.done }), { id });
      }
    } catch (err) {
      // 整轮没跑起来,或者流中途断了。**同步本身可能仍在服务端跑** —— 所以照样 invalidate,
      // 让下次读取拿到已经落库的部分。
      toast.error(
        t("syncFailed", {
          count: accounts.length,
          details: err instanceof Error ? err.message : String(err),
        }),
        { id },
      );
    } finally {
      await router.invalidate();
      setBusy(false);
    }
  }

  return { busy, disabled, sync };
}
