import { SettingsStore } from "@folio/db";
import { z } from "zod";
import { runStore } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";

// per-user 估值设置(Phase 3,#82)。读带缺省(无行 → coingecko / self-first)。
export function handleGetValuationSettings({ context }: { context: AuthContext }) {
  return runStore(context.userId, SettingsStore, (s) => s.get());
}

// 切换估值模式:source-first = 统一采用市场源价、重算当前视图(历史冻结、无需重 sync)。
export const ValuationInput = z.object({ mode: z.enum(["self-first", "source-first"]) });

export async function handleUpdateValuationSettings({
  data,
  context,
}: {
  data: z.infer<typeof ValuationInput>;
  context: AuthContext;
}) {
  await runStore(context.userId, SettingsStore, (s) => s.update({ valuationMode: data.mode }));
  return { ok: true };
}
