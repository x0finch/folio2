import {
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  MorphingModal,
  Separator,
} from "@folio/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { invalidateFor } from "@/lib/queries/refresh";
import { dataStatsQuery } from "@/lib/queries/settings";
import type { ImportCounts } from "@/lib/server/io/import-data";

// 数据卡(合一):导出段 + 分隔线 + 导入段。复用现有 /api/export、/api/import 路由。
// 导入文案沿用 Accounts 命名空间的 import* 键(与账户页导入同源)。
export function DataCard() {
  const queryClient = useQueryClient();
  const t = useTranslations("Settings");
  const ta = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const inputRef = useRef<HTMLInputElement>(null);
  const statsQuery = useQuery(dataStatsQuery());
  // 非空库导入是合并式(幂等,不翻倍),但先弹一道确认 —— 让用户明确知道是「并进已有数据」。
  // 统计还没到或失败:按「库可能非空」多问一次,不要在未知时直接写入。
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  function clearInput() {
    if (inputRef.current) inputRef.current.value = "";
  }

  // 导入是「选了文件才发生一次的写」——用 useMutation 而非手搓 msg/error/busy 三个 state:
  // isPending 是单一事实源(直接接到 input/按钮的 disabled 上),连点两次也只跑一个;
  // 成功/失败各自的文案直接读 data/error,后回来的请求不会覆写前一条的状态(#241)。
  const importMutation = useMutation({
    mutationFn: importData,
    // 导入什么都可能变(账户 / 快照 / 标签 / 组合);流式写入中途失败也可能已落部分行,成败都刷。
    onSettled: () => {
      clearInput();
      invalidateFor(queryClient, "settings.data");
    },
  });

  function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (statsQuery.data?.hasData === false) {
      importMutation.mutate(file);
      return;
    }
    setPendingFile(file);
  }

  function confirmImport() {
    const file = pendingFile;
    setPendingFile(null);
    if (file) importMutation.mutate(file);
  }

  function cancelImport() {
    setPendingFile(null);
    clearInput();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("data")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <p className="min-w-0 text-sm text-muted-foreground">{t("exportHint")}</p>
          <a
            href="/api/export"
            download
            className={buttonVariants({
              variant: "outline",
              className: "shrink-0 whitespace-nowrap",
            })}
          >
            {t("exportData")}
          </a>
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-4">
            <p className="min-w-0 text-sm text-muted-foreground">{ta("importHint")}</p>
            <input
              ref={inputRef}
              type="file"
              accept=".ndjson,application/x-ndjson,application/json"
              className="hidden"
              disabled={importMutation.isPending}
              onChange={onImportFile}
            />
            <Button
              type="button"
              variant="outline"
              disabled={importMutation.isPending}
              className="shrink-0 whitespace-nowrap"
              onClick={() => inputRef.current?.click()}
            >
              {importMutation.isPending ? tc("verifying") : ta("importBtn")}
            </Button>
          </div>
          {importMutation.isSuccess && (
            <p className="text-sm text-muted-foreground">
              {ta("imported", {
                accounts: importMutation.data.imported.accounts,
                snapshots: importMutation.data.imported.snapshots,
              })}
            </p>
          )}
          {importMutation.isError && (
            <p className="text-sm text-destructive">{importMutation.error.message}</p>
          )}
        </div>
      </CardContent>

      <MorphingModal viewId={pendingFile ? "import-merge" : null} onClose={cancelImport}>
        <div className="text-left">
          <p className="font-semibold text-base">{t("importMergeTitle")}</p>
          <p className="mt-1.5 text-muted-foreground text-sm">{t("importMergeBody")}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={cancelImport}>
              {tc("cancel")}
            </Button>
            <Button onClick={confirmImport}>{t("importMergeConfirm")}</Button>
          </div>
        </div>
      </MorphingModal>
    </Card>
  );
}

// 走 `/api/import` 而不是 server function:传的是文件本体,二进制塞进 server fn 得先 base64。
// 失败把服务端纯文本错误原样抛出,不在这里重试。
async function importData(file: File): Promise<{ imported: ImportCounts }> {
  const res = await fetch("/api/import", { method: "POST", body: file });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ imported: ImportCounts }>;
}
