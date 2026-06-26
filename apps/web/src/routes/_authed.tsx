import { Button } from "@folio/ui";
import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";
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
  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-center gap-4 border-b pb-4">
        <span className="font-bold">Folio</span>
        <nav className="flex gap-4 text-sm">
          <Link to="/" className="text-muted-foreground [&.active]:text-foreground">
            Overview
          </Link>
          <Link to="/accounts" className="text-muted-foreground [&.active]:text-foreground">
            Accounts
          </Link>
        </nav>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={async () => {
            await signOut();
            navigate({ to: "/login" });
          }}
        >
          Sign out
        </Button>
      </header>
      <Outlet />
    </div>
  );
}
