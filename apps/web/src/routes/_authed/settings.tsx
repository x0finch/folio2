import { buttonVariants, Card, CardContent, CardHeader, CardTitle } from "@folio/ui";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { getKeyStatus } from "../../lib/server/settings";

export const Route = createFileRoute("/_authed/settings")({
  loader: () => getKeyStatus(),
  component: Settings,
});

// 全局 provider key(品牌名不翻译);env 名是 getKeyStatus 返回的 key。
const PROVIDER_KEYS = [
  { env: "ZERION_API_KEY", label: "Zerion (EVM)" },
  { env: "COINSTATS_API_KEY", label: "CoinStats (Solana / Sui / Cosmos)" },
] as const;

function Settings() {
  const status = Route.useLoaderData();
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
    </div>
  );
}
