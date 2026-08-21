import { Button, Card, CardContent, CardHeader, CardTitle, MorphingModal, toast } from "@folio/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { signOut } from "@/lib/core/auth-client";
import { clearIdleLockState } from "@/lib/hooks/use-idle-lock";

export function UserCard({ user }: { user: { name?: string | null; email?: string | null } }) {
  const t = useTranslations("Settings");
  const ts = useTranslations("Sidebar");
  const tc = useTranslations("Common");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
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
      <CardContent>
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
