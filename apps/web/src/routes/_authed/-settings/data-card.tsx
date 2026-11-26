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

// Import copy reuses the Accounts namespace's import* keys.
export function DataCard() {
  const queryClient = useQueryClient();
  const t = useTranslations("Settings");
  const ta = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const inputRef = useRef<HTMLInputElement>(null);
  const statsQuery = useQuery(dataStatsQuery());
  // Importing into a non-empty library merges, so confirm first; unknown stats count as non-empty.
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  function clearInput() {
    if (inputRef.current) inputRef.current.value = "";
  }

  const importMutation = useMutation({
    mutationFn: importData,
    // A streamed import can partially land even on failure, so refresh either way.
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
          <p className="mt-2 text-muted-foreground text-sm">{t("importMergeBody")}</p>
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

// A route, not a server fn: a server fn would need the file base64-encoded.
async function importData(file: File): Promise<{ imported: ImportCounts }> {
  const res = await fetch("/api/import", { method: "POST", body: file });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ imported: ImportCounts }>;
}
