import { Database } from "@folio/db";
import { Effect } from "effect";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import { isComplete, readStoredCreds, safeView } from "@/lib/server/creds";

// 富化:把每账户的 raw creds 投影成 needsCredentials + credsSafe(public 原样、semi 打码、secret 丢弃);
// raw creds(含 secret 密文)绝不出网,只出投影。
export const handleListAccounts = Effect.fn("listAccounts")(function* () {
  const { accounts: store } = yield* Database;
  const specsByType = (yield* ConnectorRegistry).specs;
  const [accounts, rawList] = yield* Effect.all([store.list(), store.listRawCreds()], {
    concurrency: 2,
  });
  const rawById = new Map(rawList.map((r) => [r.id, r.creds]));
  // 解不开的那些行:按「没凭据」渲染,并把 id 攒起来一次性 warn(#527 裁定 1)。以前这里是裸
  // `JSON.parse`,一行坏数据整页打不开 —— 而账户页恰恰是唯一能重填凭据、把它修好的地方。
  const unreadable: string[] = [];
  const rows = accounts.map((a) => {
    const parsed = readStoredCreds(rawById.get(a.id));
    if (parsed === null) unreadable.push(a.id);
    const stored = parsed ?? {};
    const specs = specsByType[a.connectorId] ?? [];
    return {
      ...a,
      needsCredentials: !isComplete(specs, stored),
      credsSafe: safeView(specs, stored),
    };
  });
  if (unreadable.length > 0) {
    yield* Effect.logWarning("stored creds unreadable, listed as incomplete").pipe(
      Effect.annotateLogs({ accountIds: unreadable }),
    );
  }
  return rows;
});
