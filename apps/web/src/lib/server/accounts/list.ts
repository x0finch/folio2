import { AccountStore } from "@folio/db";
import { Effect } from "effect";
import { credentialSpecs } from "../connectors/registry";
import { isComplete, safeView } from "../creds";
import { runStore } from "../oracle";
import type { AuthContext } from "../session/auth-session";

// 富化:把每账户的 raw creds 投影成 needsCredentials + credsSafe(public 原样、semi 打码、secret 丢弃);
// raw creds(含 secret 密文)绝不出网,只出投影。
export async function handleListAccounts({ context }: { context: AuthContext }) {
  const [accounts, rawList] = await runStore(context.userId, AccountStore, (s) =>
    Effect.all([s.list(), s.listRawCreds()], { concurrency: 2 }),
  );
  const rawById = new Map(rawList.map((r) => [r.id, r.creds]));
  const specsByType = credentialSpecs();
  return accounts.map((a) => {
    const raw = rawById.get(a.id);
    const stored: Record<string, string> = raw ? JSON.parse(raw) : {};
    const specs = specsByType[a.connectorId] ?? [];
    return {
      ...a,
      needsCredentials: !isComplete(specs, stored),
      credsSafe: safeView(specs, stored),
    };
  });
}
