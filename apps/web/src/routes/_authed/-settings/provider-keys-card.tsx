import { Card, CardContent, CardHeader, CardTitle, Skeleton } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { providerKeyStatusQuery } from "../../../lib/queries/settings";

const PROVIDER_KEYS = [
  { env: "ZERION_API_KEY", label: "Zerion (EVM 备源,可不配)" },
  { env: "COINSTATS_API_KEY", label: "CoinStats (Solana / Sui / Cosmos)" },
] as const;

const KEEP_TRYING = { retry: true as const };

export function ProviderKeysCard() {
  const t = useTranslations("Settings");
  const statusQuery = useQuery({ ...providerKeyStatusQuery(), ...KEEP_TRYING });
  const status = statusQuery.data;
  const rows =
    status == null
      ? PROVIDER_KEYS.map((k) => (
          <li key={k.env} className="flex items-center justify-between">
            <span>{k.label}</span>
            <Skeleton className="h-5 w-16" />
          </li>
        ))
      : PROVIDER_KEYS.map((k) => (
          <li key={k.env} className="flex items-center justify-between">
            <span>{k.label}</span>
            <span className={status[k.env] ? "text-foreground" : "text-muted-foreground"}>
              {status[k.env] ? t("configured") : t("notConfigured")}
            </span>
          </li>
        ));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("providerKeys")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">{rows}</ul>
      </CardContent>
    </Card>
  );
}
