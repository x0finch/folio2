import {
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Label,
} from "@folio/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { getKeyStatus, getValuationSettings, setValuationMode } from "../../lib/server/settings";

export const Route = createFileRoute("/_authed/settings")({
  loader: async () => {
    const [status, valuation] = await Promise.all([getKeyStatus(), getValuationSettings()]);
    return { status, valuation };
  },
  component: Settings,
});

// 全局 provider key(品牌名不翻译);env 名是 getKeyStatus 返回的 key。
const PROVIDER_KEYS = [
  { env: "ZERION_API_KEY", label: "Zerion (EVM)" },
  { env: "COINSTATS_API_KEY", label: "CoinStats (Solana / Sui / Cosmos)" },
] as const;

function Settings() {
  const { status, valuation } = Route.useLoaderData();
  const t = useTranslations("Settings");
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t("providerKeys")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2">
            {PROVIDER_KEYS.map((k) => (
              <li key={k.env} className="flex items-center justify-between">
                <span>{k.label}</span>
                <span className={status[k.env] ? "text-foreground" : "text-muted-foreground"}>
                  {status[k.env] ? t("configured") : t("notConfigured")}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <ValuationCard mode={valuation.valuationMode} />

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

// 估值模式(Phase 3,#82):勾选 = source-first(统一采用市场源价);不勾 = self-first(默认)。
// 切换即写 user_settings + invalidate → 主页/图表现推立即改(历史冻结,无需重 sync)。
function ValuationCard({ mode }: { mode: "self-first" | "source-first" }) {
  const router = useRouter();
  const t = useTranslations("Settings");
  const [sourceFirst, setSourceFirst] = useState(mode === "source-first");
  const [busy, setBusy] = useState(false);

  async function onToggle(checked: boolean) {
    setSourceFirst(checked); // 乐观更新
    setBusy(true);
    try {
      await setValuationMode({ data: { mode: checked ? "source-first" : "self-first" } });
      await router.invalidate(); // 刷新总览/图表读路径
    } catch {
      setSourceFirst(!checked); // 回滚
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("valuation")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="valuation-source-first"
            checked={sourceFirst}
            disabled={busy}
            onCheckedChange={onToggle}
          />
          <Label htmlFor="valuation-source-first">{t("useSourcePrice")}</Label>
        </div>
        <p className="text-sm text-muted-foreground">{t("valuationHint")}</p>
      </CardContent>
    </Card>
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
