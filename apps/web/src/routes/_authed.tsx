import { Button } from "@folio/ui";
import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { LocaleSwitcher } from "../components/locale-switcher";
import { signOut } from "../lib/auth-client";
import { fetchCurrentUser } from "../lib/server/session";

// 受保护布局:无 session 则重定向到 /login(仅 UX;数据安全靠各 authedServerFn)。
export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const current = await fetchCurrentUser();
    if (!current) throw redirect({ to: "/login" });
    return { user: current.user };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const navigate = useNavigate();
  const t = useTranslations("Nav");
  const tc = useTranslations("Common");
  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-center gap-4 border-b pb-4">
        <span className="font-bold">Folio</span>
        <nav className="flex gap-4 text-sm">
          <Link to="/" className="text-muted-foreground [&.active]:text-foreground">
            {t("overview")}
          </Link>
          <Link to="/accounts" className="text-muted-foreground [&.active]:text-foreground">
            {t("accounts")}
          </Link>
          <Link to="/settings" className="text-muted-foreground [&.active]:text-foreground">
            {t("settings")}
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <LocaleSwitcher />
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await signOut();
              navigate({ to: "/login" });
            }}
          >
            {tc("signOut")}
          </Button>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
