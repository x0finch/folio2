import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  MorphingModal,
  toast,
} from "@folio/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { IconButton } from "@/components/icon-button";
import { signOut } from "@/lib/core/auth-client";
import { clearIdleLockState } from "@/lib/hooks/use-idle-lock";
import { checkForUpdate, showUpdateToast, UPDATE_TOAST_ID } from "@/lib/pwa/service-worker";
import { SettingRow } from "./setting-row";

// 刷新图标最短旋转时长(ms):让它转一圈,别检查太快时一闪而过。
const MIN_SPIN_MS = 700;

// 展示版本(构建期 git describe 注入,见 vite.config)。去掉 `-g<hash>` 后缀,只留 `v0.14.0-21`
// 这样的形状;CI 浅克隆无 tag 时它就是短 hash,原样显示。
// `typeof` 守卫:vitest 不套 vite 的 define,`__APP_VERSION__` 在测试里未定义(本文件的 userIdentity
// 被 user-identity.test 引),裸引会 ReferenceError —— 退到 "dev"。
const APP_VERSION = (typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__).replace(
  /-g[0-9a-f]+$/i,
  "",
);

export function UserCard({ user }: { user: { name?: string | null; email?: string | null } }) {
  const t = useTranslations("Settings");
  const ts = useTranslations("Sidebar");
  const tc = useTranslations("Common");
  const tu = useTranslations("Update");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  // 手动查更新:图标转一圈(带最短时长,别一闪),查完**无论有没有新版都 toast**。有则「有新版本·更新」
  // (点走 applyUpdate),无则「已是最新」;共用 id `sw-update`,和运行中自动提示的那条 toast 收敛成一条、不叠。
  async function onCheckUpdate() {
    if (checking) return;
    setChecking(true);
    const start = Date.now();
    const found = await checkForUpdate();
    const rest = MIN_SPIN_MS - (Date.now() - start);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
    setChecking(false);
    // 共用 service-worker 的那处 toast(同 id、同去重),无则「已是最新」。
    if (found) showUpdateToast({ available: tu("available"), update: tu("update") });
    else toast.success(tu("upToDate"), { id: UPDATE_TOAST_ID });
  }
  const id = userIdentity(user);
  const secondary = id.secondary.kind === "email" ? id.secondary.value : ts("selfHosted");

  const signOutMut = useMutation({
    mutationFn: async () => {
      const res = await signOut();
      if (res?.error) throw new Error(res.error.message ?? t("signOutFailed"));
    },
    onSuccess: () => {
      clearIdleLockState();
      queryClient.clear();
      navigate({ to: "/login" });
    },
    onError: (err) => {
      toast.error(err.message || t("signOutFailed"));
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("user")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-foreground text-sm">
              {id.initial}
            </div>
            <div className="min-w-0 leading-tight">
              <div className="truncate font-medium text-sm">{id.primary}</div>
              <div className="truncate text-muted-foreground text-sm">{secondary}</div>
            </div>
          </div>
          <Button variant="outline" onClick={() => setConfirmOpen(true)}>
            <LogOut className="size-4" />
            {t("signOut")}
          </Button>
        </div>

        {/* 版本行:左「版本」,右版本号 + ghost 刷新(点击转一圈 + 总是 toast)。 */}
        <div className="border-border border-t pt-4">
          <SettingRow label={t("version")}>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-muted-foreground text-sm">{APP_VERSION}</span>
              <IconButton
                aria-label={t("checkUpdate")}
                size="sm"
                disabled={checking}
                onClick={onCheckUpdate}
              >
                <RefreshCw className={cn("size-4", checking && "animate-spin")} />
              </IconButton>
            </div>
          </SettingRow>
        </div>
      </CardContent>

      <MorphingModal viewId={confirmOpen ? "signout" : null} onClose={() => setConfirmOpen(false)}>
        <div className="text-left">
          <p className="font-semibold text-base">{t("signOutConfirmTitle")}</p>
          <p className="mt-1.5 text-muted-foreground text-sm">{t("signOutConfirmBody")}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={signOutMut.isPending}
              onClick={() => signOutMut.mutate()}
            >
              {t("signOut")}
            </Button>
          </div>
        </div>
      </MorphingModal>
    </Card>
  );
}

// 登录用户身份派生(grill Q4):「自托管」是本地化文案,不进纯函数 → secondary 用 kind 判别。
// 这是登录的人,不是 Folio 里导入的账户。
type UserSecondary = { kind: "email"; value: string } | { kind: "selfHosted" };

export function userIdentity(user: { name?: string | null; email?: string | null }): {
  primary: string;
  secondary: UserSecondary;
  initial: string;
} {
  const name = (user.name ?? "").trim();
  const email = (user.email ?? "").trim();
  const primary = name || email || "?";
  const secondary: UserSecondary =
    name && email ? { kind: "email", value: email } : { kind: "selfHosted" };
  const initial = primary.charAt(0).toUpperCase() || "?";
  return { primary, secondary, initial };
}
