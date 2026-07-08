import { Button, buttonVariants, Card, CardContent, CardHeader, CardTitle } from "@folio/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { ProviderTypesCard } from "../../components/provider-types-card";
import { listProviderStatus } from "../../lib/server/provider-admin";

export const Route = createFileRoute("/_authed/settings")({
  loader: () => listProviderStatus(),
  component: Settings,
});

function Settings() {
  const status = Route.useLoaderData();
  const t = useTranslations("Settings");
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>

      {/* 账户类型管理(ADR 0009):启用/配置数据源取代旧的静态 env key 自检卡。 */}
      <ProviderTypesCard status={status} />

      <Card>
        <CardHeader>
          <CardTitle>{t("export")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">{t("exportHint")}</p>
          <a href="/api/export" download className={buttonVariants()}>
            {t("exportData")}
          </a>
        </CardContent>
      </Card>

      <ImportCard />
    </div>
  );
}

// 数据导入(P6.6):POST 文件到 /api/import(流式 NDJSON);成功后 invalidate 刷新。
// 从账户页迁来(账户页专注展示);文案沿用 Accounts 命名空间的 import* 键。
function ImportCard() {
  const router = useRouter();
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const inputRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMsg(null);
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/import", { method: "POST", body: file });
      if (!res.ok) throw new Error(await res.text());
      const { imported } = (await res.json()) as {
        imported: { accounts: number; groups: number; snapshots: number };
      };
      setMsg(
        t("imported", {
          accounts: imported.accounts,
          groups: imported.groups,
          snapshots: imported.snapshots,
        }),
      );
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("importTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">{t("importHint")}</p>
          <input
            ref={inputRef}
            type="file"
            accept=".ndjson,application/x-ndjson,application/json"
            className="hidden"
            onChange={onImportFile}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            className="self-start"
            onClick={() => inputRef.current?.click()}
          >
            {busy ? tc("verifying") : t("importBtn")}
          </Button>
          {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
