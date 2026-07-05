import type { AccountType } from "@folio/balances";
import {
  Button,
  Input,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  toast,
} from "@folio/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import type { OverviewBalance } from "../lib/account-view";
import { deleteAccount, renameAccount, setAccountArchived } from "../lib/server/accounts";
import type { InputSpec } from "../lib/server/credentials";
import { syncOneAccount } from "../lib/server/sync";
import { AccountTypeBadge } from "./account-type-badge";
import { CredentialForm } from "./credential-form";
import { AccountHoldingsCards } from "./holdings-cards";
import { useUsd } from "./holdings-sections";
import { ManualActivityPanel } from "./manual-activity-panel";

// 账户页列表行的合并形状(getMyOverview ∪ listMyAccounts,见 accounts.tsx loader)。
export interface AccountRow {
  id: string;
  label: string;
  type: AccountType;
  archivedAt: number | null;
  totalUsd: number;
  takenAt: number | null;
  balances: OverviewBalance[];
  needsCredentials: boolean;
  credsSafe: Record<string, string>;
}

// 账户详情侧栏:点击账户行打开。头部(label/类型/市值/上次同步)+ 操作(单独同步/重命名/归档/删除/补录凭据)
// + 全部持仓;manual 账户额外挂活动录入。所有写操作成功后 router.invalidate() 刷新列表与总览。
export function AccountDetailSheet({
  account,
  specs,
  open,
  onOpenChange,
}: {
  account: AccountRow | null;
  specs: InputSpec[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto p-6 sm:max-w-lg">
        {account && (
          <DetailBody
            key={account.id}
            account={account}
            specs={specs}
            onClose={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

// key={account.id} 重挂 → 切账户自动清空 rename/confirm 等本地态。
function DetailBody({
  account,
  specs,
  onClose,
}: {
  account: AccountRow;
  specs: InputSpec[];
  onClose: () => void;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const format = useFormatter();
  const router = useRouter();
  const usd = useUsd();
  const refresh = () => router.invalidate();

  const archived = account.archivedAt != null;
  const [renaming, setRenaming] = useState(false);
  const [labelDraft, setLabelDraft] = useState(account.label);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 操作反馈统一走 toast(D07):同步给出成/败,写操作失败提示,成功以列表刷新为可见反馈。
  const syncMut = useMutation({
    mutationFn: () => syncOneAccount({ data: { accountId: account.id } }),
    onSuccess: async (r) => {
      if (r.ok) toast.success(t("synced", { count: 1 }));
      else if (!r.skipped) toast.error(r.error ?? t("syncGenericError"));
      await refresh();
    },
    onError: () => toast.error(t("syncGenericError")),
  });
  const renameMut = useMutation({
    mutationFn: () => renameAccount({ data: { accountId: account.id, label: labelDraft.trim() } }),
    onSuccess: async () => {
      setRenaming(false);
      await refresh();
    },
    onError: () => toast.error(t("actionFailed")),
  });
  const archiveMut = useMutation({
    mutationFn: () => setAccountArchived({ data: { accountId: account.id, archived: !archived } }),
    onSuccess: refresh,
    onError: () => toast.error(t("actionFailed")),
  });
  const deleteMut = useMutation({
    mutationFn: () => deleteAccount({ data: { accountId: account.id } }),
    onSuccess: async () => {
      onClose();
      await refresh();
    },
    onError: () => toast.error(t("actionFailed")),
  });

  const lastSynced = account.takenAt
    ? t("lastSyncedAt", { when: format.relativeTime(new Date(account.takenAt)) })
    : t("neverSynced");

  return (
    <>
      <SheetHeader className="p-0">
        <SheetTitle className="flex items-center gap-2">
          <span>{account.label}</span>
          <AccountTypeBadge type={account.type} />
          {archived && (
            <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {t("archivedBadge")}
            </span>
          )}
        </SheetTitle>
        <SheetDescription>
          {usd(account.totalUsd)} · {lastSynced}
        </SheetDescription>
      </SheetHeader>

      {/* 操作区 */}
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={archived || syncMut.isPending}
            onClick={() => syncMut.mutate()}
          >
            {syncMut.isPending ? tc("verifying") : t("syncThis")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setRenaming((v) => !v)}>
            {t("rename")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={archiveMut.isPending}
            onClick={() => archiveMut.mutate()}
          >
            {archived ? t("unarchive") : t("archive")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            {tc("delete")}
          </Button>
        </div>

        {renaming && (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              renameMut.mutate();
            }}
          >
            <Input
              autoFocus
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" size="sm" disabled={renameMut.isPending || !labelDraft.trim()}>
              {renameMut.isPending ? tc("verifying") : tc("save")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>
              {tc("cancel")}
            </Button>
          </form>
        )}

        {confirmDelete && (
          <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm text-destructive">{t("deleteConfirm")}</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmDelete(false)}
                disabled={deleteMut.isPending}
              >
                {tc("cancel")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => deleteMut.mutate()}
                disabled={deleteMut.isPending}
              >
                {deleteMut.isPending ? tc("verifying") : t("deleteConfirmBtn")}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* 缺凭据 → 补录 */}
      {account.needsCredentials && (
        <div className="mt-4">
          <p className="text-sm font-medium text-destructive">{t("provideCredentials")}</p>
          <CredentialForm
            accountId={account.id}
            specs={specs}
            hint={account.credsSafe}
            onDone={refresh}
          />
        </div>
      )}

      {/* 持仓(卡片列表) */}
      <div className="mt-6">
        <AccountHoldingsCards balances={account.balances} />
      </div>

      {/* manual 活动 */}
      {account.type === "manual" && (
        <div className="mt-6">
          <ManualActivityPanel accountId={account.id} />
        </div>
      )}
    </>
  );
}
