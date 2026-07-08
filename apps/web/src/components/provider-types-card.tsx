import type { InputSpec } from "@folio/balances";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Drawer,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@folio/ui";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { TYPE_GROUPS, typeLabel } from "../lib/account-types";
import type { AccountTypeStatusView, ProviderCandidateView } from "../lib/provider-status";
import { disableAccountType, enableProvider } from "../lib/server/provider-admin";

// 账户类型管理(ADR 0009 ③):每类型一行(三态)+ 启用/配置抽屉(选 provider、默认/自定义 key)。
// secret 只进不出:表单值发 server fn 加密落库,永不回显(占位提示"已存自定义")。

function stateOf(v: AccountTypeStatusView): "active" | "unconfigured" | "off" {
  if (v.activeId && v.configured) return "active";
  if (v.activeId) return "unconfigured";
  return "off";
}

export function ProviderTypesCard({ status }: { status: AccountTypeStatusView[] }) {
  const t = useTranslations("Settings");
  const byType = new Map(status.map((s) => [s.accountType, s]));
  const [editing, setEditing] = useState<AccountTypeStatusView | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("accountTypes")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {TYPE_GROUPS.flatMap((g) => g.types).map((type) => {
            const s = byType.get(type);
            if (!s) return null;
            const state = stateOf(s);
            const active = s.candidates.find((c) => c.id === s.activeId);
            return (
              <li key={type} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span>{typeLabel(type)}</span>
                  {active && (
                    <span className="text-xs text-muted-foreground">{active.dataSource}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    size="sm"
                    status={
                      state === "active"
                        ? "success"
                        : state === "unconfigured"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {state === "active" && t("stateActive")}
                    {state === "unconfigured" && t("stateUnconfigured")}
                    {state === "off" && t("stateOff")}
                  </Badge>
                  <Button size="sm" variant="outline" onClick={() => setEditing(s)}>
                    {state === "off" ? t("enable") : t("configure")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
      {editing && <EnableDrawer status={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function EnableDrawer({ status, onClose }: { status: AccountTypeStatusView; onClose: () => void }) {
  const t = useTranslations("Settings");
  const tIn = useTranslations("Inputs");
  const router = useRouter();
  const [providerId, setProviderId] = useState(status.activeId ?? status.candidates[0]?.id ?? "");
  const candidate = status.candidates.find((c) => c.id === providerId);
  // 无内置默认可用时只能自定义 → 初始即展开;切 provider 时按新候选重算(见 onPickProvider)。
  const needsCustom = (c?: ProviderCandidateView) =>
    Boolean(c && !c.hasEnvDefault && c.configFields.length > 0);
  const [useCustom, setUseCustom] = useState(needsCustom(candidate));
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  async function onDisable() {
    setBusy(true);
    try {
      await disableAccountType({ data: { accountType: status.accountType } });
      toast.success(t("closeDone"));
      router.invalidate();
      onClose();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    if (!candidate) return;
    setBusy(true);
    try {
      const filled = candidate.configFields.every((f) => values[f.key]?.trim());
      await enableProvider({
        data: {
          providerId,
          // 自定义模式且填全才提交 settings;否则只启用(沿用已存自定义/内置默认)。
          ...(useCustom && filled ? { settings: values } : {}),
        },
      });
      toast.success(t("saved"));
      router.invalidate();
      onClose();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onOpenChange={(open) => !open && onClose()}
      side="right"
      ariaLabel={t("accountTypes")}
      className="w-full overflow-y-auto p-6 sm:max-w-md"
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold">{typeLabel(status.accountType)}</h2>
        <p className="text-sm text-muted-foreground">{t("enableHint")}</p>
      </div>

      {status.candidates.length > 1 && (
        <div className="mt-4 flex flex-col gap-2">
          <Label>{t("provider")}</Label>
          <Select
            value={providerId}
            onValueChange={(v) => {
              // 切候选:清残留输入 + 按新候选重算默认/自定义(否则旧值/旧态串到新 provider)。
              setProviderId(v);
              setValues({});
              setUseCustom(needsCustom(status.candidates.find((c) => c.id === v)));
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {status.candidates.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.dataSource}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {candidate && candidate.configFields.length > 0 && (
        <SettingsFields
          candidate={candidate}
          useCustom={useCustom}
          setUseCustom={setUseCustom}
          values={values}
          setValues={setValues}
          t={t}
          tIn={tIn}
        />
      )}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button onClick={onSave} disabled={busy || !candidate}>
          {t("enable")}
        </Button>
      </div>

      {/* 关闭类型(仅已启用时可见):有账户 → 行内确认(归档 + 停同步);无账户 → 直接关。 */}
      {status.activeId && (
        <div className="mt-6 border-t border-border pt-4">
          {confirmClose ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-destructive">
                {t("closeConfirm", { count: status.accountCount })}
              </p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setConfirmClose(false)}>
                  {t("cancel")}
                </Button>
                <Button size="sm" variant="destructive" onClick={onDisable} disabled={busy}>
                  {t("closeType")}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => (status.accountCount > 0 ? setConfirmClose(true) : onDisable())}
              disabled={busy}
            >
              {t("closeType")}
            </Button>
          )}
        </div>
      )}
    </Drawer>
  );
}

function SettingsFields({
  candidate,
  useCustom,
  setUseCustom,
  values,
  setValues,
  t,
  tIn,
}: {
  candidate: ProviderCandidateView;
  useCustom: boolean;
  setUseCustom: (v: boolean) => void;
  values: Record<string, string>;
  setValues: (v: Record<string, string>) => void;
  t: ReturnType<typeof useTranslations<"Settings">>;
  tIn: ReturnType<typeof useTranslations<"Inputs">>;
}) {
  return (
    <div className="mt-4 flex flex-col gap-3">
      {(candidate.hasEnvDefault || candidate.hasCustomSettings) && (
        <div className="flex items-center justify-between">
          <span className="text-sm">
            {useCustom
              ? t("customKey")
              : candidate.hasCustomSettings
                ? t("customStored")
                : t("useDefault")}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setUseCustom(!useCustom)}>
            {useCustom ? t("useDefault") : t("customKey")}
          </Button>
        </div>
      )}
      {useCustom &&
        candidate.configFields.map((f: InputSpec) => (
          <div key={f.key} className="flex flex-col gap-1.5">
            <Label htmlFor={`pf-${f.key}`}>{tIn(f.label as never)}</Label>
            <Input
              id={`pf-${f.key}`}
              type={f.type === "secret" ? "password" : "text"}
              value={values[f.key] ?? ""}
              placeholder={candidate.hasCustomSettings ? t("customStored") : undefined}
              onChange={(v) => setValues({ ...values, [f.key]: v })}
            />
          </div>
        ))}
      {useCustom && <p className="text-xs text-muted-foreground">{t("customKeyHint")}</p>}
    </div>
  );
}
