import { PortfolioStore } from "@folio/db";
import { Effect } from "effect";
import { runStore } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";

// 该用户的全部 Portfolio(选择器数据源)+ 默认 id。ensureDefault 保证至少有默认那行。
export async function handleListPortfolios({ context }: { context: AuthContext }) {
  const [portfolios, defaultPf] = await runStore(context.userId, PortfolioStore, (s) =>
    Effect.all([s.list(), s.ensureDefault()], { concurrency: 2 }),
  );
  return {
    portfolios: portfolios.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault })),
    defaultId: defaultPf.id,
  };
}
