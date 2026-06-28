import { Button, Input, Label } from "@folio/ui";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { provideCredentials } from "../lib/server/accounts";
import type { InputSpec } from "../lib/server/credentials";

// 动态补录表单(P6.6):按 provider 的 inputs 规格渲染字段(secret→password),label/desc 走 Inputs i18n
// (label 兼作 i18n key)。提交 → provideCredentials(校验 + live + 加密入库),成功后 onDone()。
export function CredentialForm({
  accountId,
  specs,
  onDone,
}: {
  accountId: string;
  specs: InputSpec[];
  onDone: () => void;
}) {
  const ti = useTranslations("Inputs");
  const tc = useTranslations("Common");
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await provideCredentials({ data: { accountId, creds: values } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-2 flex flex-col gap-2">
      {specs.map((s) => (
        <div key={s.key} className="flex flex-col gap-1">
          <Label htmlFor={`cred-${accountId}-${s.key}`}>{ti(s.label)}</Label>
          <Input
            id={`cred-${accountId}-${s.key}`}
            type={s.type === "secret" ? "password" : "text"}
            required
            value={values[s.key] ?? ""}
            placeholder={s.desc ? ti(s.desc) : undefined}
            onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.value }))}
          />
        </div>
      ))}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={busy} className="self-start">
        {busy ? tc("verifying") : tc("save")}
      </Button>
    </form>
  );
}
