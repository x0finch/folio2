import { Skeleton } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { providerKeyStatusQuery } from "@/lib/queries/settings";
import { SettingsSection } from "./settings-section";

const PROVIDER_KEYS = [
  { env: "ZERION_API_KEY", label: "Zerion" },
  { env: "COINSTATS_API_KEY", label: "CoinStats" },
] as const;

const KEEP_TRYING = { retry: true as const };

export function ProviderKeysCard() {
  const t = useTranslations("Settings");
  const statusQuery = useQuery({ ...providerKeyStatusQuery(), ...KEEP_TRYING });
  const status = statusQuery.data;
  return (
    <SettingsSection title={t("providerKeys")}>
      <ul className="flex flex-col gap-6 text-sm">
        {PROVIDER_KEYS.map((k) => (
          <li key={k.env} className="flex items-center justify-between">
            <span>{k.label}</span>
            {status == null ? (
              <Skeleton className="h-5 w-16" />
            ) : (
              <span className={status[k.env] ? "text-foreground" : "text-muted-foreground"}>
                {status[k.env] ? t("configured") : t("notConfigured")}
              </span>
            )}
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}
