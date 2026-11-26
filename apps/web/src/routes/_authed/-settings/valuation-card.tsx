import { Checkbox, Label, Skeleton } from "@folio/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { invalidateFor } from "@/lib/queries/refresh";
import { valuationSettingsQuery } from "@/lib/queries/settings";
import { updateValuationSettings } from "@/lib/server/settings";
import { SettingsSection } from "./settings-section";

const KEEP_TRYING = { retry: true as const };

// Checked = source-first, unchecked = self-first (default). Past snapshots stay frozen.
export function ValuationCard() {
  const queryClient = useQueryClient();
  const t = useTranslations("Settings");
  const settingsQuery = useQuery({ ...valuationSettingsQuery(), ...KEEP_TRYING });
  const toggle = useMutation({
    mutationFn: (checked: boolean) =>
      updateValuationSettings({ data: { mode: checked ? "source-first" : "self-first" } }),
    onSuccess: () => invalidateFor(queryClient, "settings.valuation"),
  });
  const mode = settingsQuery.data?.valuationMode;
  const body =
    mode == null ? (
      <Skeleton className="h-5 w-64" />
    ) : (
      <div className="flex items-center gap-2">
        <Checkbox
          id="valuation-source-first"
          checked={toggle.isPending ? toggle.variables : mode === "source-first"}
          disabled={toggle.isPending}
          onCheckedChange={(checked) => toggle.mutate(checked)}
        />
        <Label htmlFor="valuation-source-first">{t("useSourcePrice")}</Label>
      </div>
    );
  return <SettingsSection title={t("valuation")}>{body}</SettingsSection>;
}
