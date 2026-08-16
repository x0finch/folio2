import { Card, CardContent, CardHeader, CardTitle } from "@folio/ui";
import { useTranslations } from "use-intl";

const PROVIDER_KEYS = [
  { env: "ZERION_API_KEY", label: "Zerion (EVM 备源,可不配)" },
  { env: "COINSTATS_API_KEY", label: "CoinStats (Solana / Sui / Cosmos)" },
] as const;

export function ProviderKeysCard({ status }: { status: Record<string, boolean> }) {
  const t = useTranslations("Settings");
  return (
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
  );
}
