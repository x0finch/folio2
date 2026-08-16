import { Button, Card, CardContent, CardHeader, CardTitle, MorphingModal } from "@folio/ui";
import { useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { type AccountUser, accountIdentity } from "../../../lib/account-identity";
import { signOut } from "../../../lib/auth-client";
import { clearIdleLockState } from "../../../lib/hooks/use-idle-lock";

export function AccountCard({ user }: { user: AccountUser }) {
  const t = useTranslations("Settings");
  const ts = useTranslations("Sidebar");
  const tc = useTranslations("Common");
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const id = accountIdentity(user);
  const secondary = id.secondary.kind === "email" ? id.secondary.value : ts("selfHosted");

  async function doSignOut() {
    // 与锁屏登出同理:不清闲置锁状态,重新登录会因旧 lastActive 已过期而当场被锁(#353)。
    clearIdleLockState();
    await signOut();
    navigate({ to: "/login" });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("account")}</CardTitle>
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
            <Button variant="destructive" onClick={doSignOut}>
              {t("signOut")}
            </Button>
          </div>
        </div>
      </MorphingModal>
    </Card>
  );
}
