import { maskCredential } from "@folio/balances";
import { Button, Input, Label } from "@folio/ui";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { provideCredentials } from "../lib/server/accounts";
import type { InputSpec } from "../lib/server/credentials";

// 动态补录表单(P6.6 / P6.6.1):按 provider 的 inputs 规格渲染字段(secret→password,其余 text),
// label/desc 走 Inputs i18n(label 兼作 key)。semi 字段(如 apiKey)若有 credHint 打码片段,
// 展示"记录的 X:abc12…wxyz"供识别;用户输入的首尾与片段对不上 → 拦下、提醒、需主动确认(兼容 key 轮换)。
// 比对逻辑 key 在 type==="semi",无字段名硬编码。提交 → provideCredentials(校验 + live + 加密入库)。
export function CredentialForm({
  accountId,
  specs,
  hint,
  onDone,
}: {
  accountId: string;
  specs: InputSpec[];
  hint?: Record<string, string>; // credsSafe(safeView):public 原样、semi 打码,均为 string
  onDone: () => void;
}) {
  const ti = useTranslations("Inputs");
  const ta = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmMismatch, setConfirmMismatch] = useState(false);

  // 与打码片段对不上的 semi 字段(首尾比对)。空 = 一致或无片段。
  function mismatchedSemiKeys(): string[] {
    return specs
      .filter((s) => s.type === "semi" && hint?.[s.key] != null)
      .filter((s) => maskCredential(values[s.key] ?? "") !== String(hint?.[s.key]))
      .map((s) => s.key);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // 不一致且未确认 → 先拦下、提醒,等用户主动确认。
    if (mismatchedSemiKeys().length > 0 && !confirmMismatch) {
      setConfirmMismatch(true);
      return;
    }
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

  function setValue(key: string, v: string) {
    setValues((vs) => ({ ...vs, [key]: v }));
    setConfirmMismatch(false); // 改动后重新评估,避免改对了仍要求确认
  }

  return (
    <form onSubmit={onSubmit} className="mt-2 flex flex-col gap-2">
      {specs.map((s) => {
        const recorded = s.type === "semi" ? hint?.[s.key] : undefined;
        return (
          <div key={s.key} className="flex flex-col gap-1">
            <Label htmlFor={`cred-${accountId}-${s.key}`}>{ti(s.label)}</Label>
            {recorded && (
              <p className="text-xs text-muted-foreground">
                {ta("credHint", { field: ti(s.label), hint: recorded })}
              </p>
            )}
            <Input
              id={`cred-${accountId}-${s.key}`}
              type={s.type === "secret" ? "password" : "text"}
              required
              value={values[s.key] ?? ""}
              placeholder={s.desc ? ti(s.desc) : undefined}
              onChange={(e) => setValue(s.key, e.target.value)}
            />
          </div>
        );
      })}
      {confirmMismatch && <p className="text-sm text-destructive">{ta("credMismatch")}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={busy} className="self-start">
        {busy ? tc("verifying") : confirmMismatch ? tc("saveAnyway") : tc("save")}
      </Button>
    </form>
  );
}
