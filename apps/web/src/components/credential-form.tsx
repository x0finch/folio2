import { maskCredential } from "@folio/connectors-basic";
import { Button } from "@folio/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslations } from "use-intl";
import type { InputSpec } from "../lib/creds";
import { incompleteSpecs } from "../lib/incomplete-specs";
import { replaceAccountCredentials } from "../lib/server/accounts";
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
  const [confirmMismatch, setConfirmMismatch] = useState(false);
  // 提交态与失败信息都由 mutation 持有 —— 手搓的 busy/error 各存一份,连点两次就发两个请求,
  // 而后回来的那次还会把先回来的错误覆盖掉。这里只有一个 pending,按钮直接接它。
  const save = useMutation({
    mutationFn: () => replaceAccountCredentials({ data: { accountId, creds: values } }),
    onSuccess: onDone,
  });

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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // 不一致且未确认 → 先拦下、提醒,等用户主动确认。走这条路要顺手 reset:
    // 否则上一次失败的红字会一直挂在「请确认」旁边,像是这次也失败了。
    if (mismatchedSemiKeys().length > 0 && !confirmMismatch) {
      save.reset();
      setConfirmMismatch(true);
      return;
    }
    save.mutate();
  }

  // 校验失败的原因要原样给用户看(哪个字段不对是上游给的),不能压成一句通用错误。
  // `save.error` 类型上是 Error,运行时未必 —— server fn / 中间层有可能以别的东西 reject。
  // 只取 `.message` 的话那种情况下红字整条不渲染:请求失败了,画面上却一个字都没有。
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
