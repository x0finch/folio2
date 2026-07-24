import { maskCredential } from "@folio/connectors-basic";
import { Button } from "@folio/ui";
import { useState } from "react";
import { useTranslations } from "use-intl";
import type { InputSpec } from "../lib/creds";
import { incompleteSpecs } from "../lib/incomplete-specs";
import { provideCredentials } from "../lib/server/accounts";
import { GenericFields } from "./account-fields";

// 动态补录表单(P6.6 → A3 v2):字段复用加账户的 GenericFields(带 new-password 安全 + 统一样式),
// 只渲染非 public 字段(incompleteSpecs);semi 字段若有 credHint 打码片段,展示"记录的 X:abc…xyz"供识别。
// 用户输入的首尾与片段对不上 → 拦下、提醒,需主动确认(兼容 key 轮换)。比对逻辑 key 在 type==="semi",
// 无字段名硬编码。提交 → provideCredentials(校验 + live + 加密入库),成功走 onDone(父层弹 toast + 后台 sync)。
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
  const ta = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const fields = incompleteSpecs(specs);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmMismatch, setConfirmMismatch] = useState(false);

  // 与打码片段对不上的 semi 字段(首尾比对)。空 = 一致或无片段。
  function mismatchedSemiKeys(): string[] {
    return fields
      .filter((s) => s.type === "semi" && hint?.[s.key] != null)
      .filter((s) => maskCredential(values[s.key] ?? "") !== String(hint?.[s.key]))
      .map((s) => s.key);
  }

  // 改动后重新评估,避免改对了仍要求确认。
  function updateValues(fn: (v: Record<string, string>) => Record<string, string>) {
    setValues(fn);
    setConfirmMismatch(false);
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
      <Button type="submit" size="sm" disabled={busy} className="self-end">
        {busy ? tc("verifying") : confirmMismatch ? tc("saveAnyway") : tc("save")}
      </Button>
    </form>
  );
}
