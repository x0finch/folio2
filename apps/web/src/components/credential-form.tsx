import { maskCredential } from "@folio/connectors-basic";
import { Button } from "@folio/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { replaceAccountCredentials } from "@/lib/server/accounts";
import type { InputSpec } from "@/lib/server/creds";
import { GenericFields } from "./account-fields";
import { incompleteSpecs } from "./incomplete-specs";

// Re-entry form for incomplete credentials. A semi field whose first/last characters don't match
// the masked hint is blocked until the user confirms (key rotation is legitimate).
export function CredentialForm({
  accountId,
  specs,
  hint,
  onDone,
}: {
  accountId: string;
  specs: InputSpec[];
  hint?: Record<string, string>; // credsSafe: public as-is, semi masked
  onDone: () => void;
}) {
  const ta = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const fields = incompleteSpecs(specs);
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmMismatch, setConfirmMismatch] = useState(false);
  // One mutation-owned pending state: hand-rolled busy/error would double-submit and let a late
  // response overwrite an earlier error.
  const save = useMutation({
    mutationFn: () => replaceAccountCredentials({ data: { accountId, creds: values } }),
    onSuccess: onDone,
  });

  // Semi fields whose first/last characters don't match the hint; empty = consistent or no hint.
  function mismatchedSemiKeys(): string[] {
    return fields
      .filter((s) => s.type === "semi" && hint?.[s.key] != null)
      .filter((s) => maskCredential(values[s.key] ?? "") !== String(hint?.[s.key]))
      .map((s) => s.key);
  }

  // Re-evaluate after any edit so a corrected value doesn't still demand confirmation.
  function updateValues(fn: (v: Record<string, string>) => Record<string, string>) {
    setValues(fn);
    setConfirmMismatch(false);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Mismatch without confirmation: block and ask. Reset so a stale error doesn't sit next to the confirm prompt.
    if (mismatchedSemiKeys().length > 0 && !confirmMismatch) {
      save.reset();
      setConfirmMismatch(true);
      return;
    }
    save.mutate();
  }

  // Show the upstream's validation reason as-is. `save.error` may not be an Error at runtime
  // (server fn / middleware can reject with anything), and `.message` alone would render nothing.
  const error = save.error == null ? null : save.error.message || String(save.error);

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <GenericFields
        specs={fields}
        values={values}
        setValues={updateValues}
        idPrefix={`cred-${accountId}`}
        hint={hint}
      />
      {confirmMismatch && <p className="text-destructive text-sm">{ta("credMismatch")}</p>}
      {error && <p className="text-destructive text-sm">{error}</p>}
      <Button type="submit" size="sm" disabled={save.isPending} className="self-end">
        {save.isPending ? tc("verifying") : confirmMismatch ? tc("saveAnyway") : tc("save")}
      </Button>
    </form>
  );
}
