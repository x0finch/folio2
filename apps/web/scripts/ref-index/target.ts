import { unstable_readConfig } from "wrangler";

// Which remote DB to refresh: account_id and database_id live only in `apps/web/wrangler.jsonc`, read here.
//
// Uses wrangler's own `unstable_readConfig` (understands JSONC and non-inherited `env`, so `--env preview` gets `folio-preview`), the same view as `wrangler d1 migrations apply`. The `unstable_` prefix is wrangler's API-stability note; the wrangler version is pinned in the catalog, so recheck on upgrade.

/** The D1 binding name in the Worker (matches wrangler.jsonc `d1_databases[].binding`). */
const DB_BINDING = "DB";

export interface D1Target {
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
}

export function readD1Target(configPath: string, env?: string): D1Target {
  const config = unstable_readConfig({ config: configPath, env });
  const db = config.d1_databases.find((d: { binding: string }) => d.binding === DB_BINDING);
  const where = `${configPath}${env ? ` (env ${env})` : ""}`;
  if (!config.account_id) throw new Error(`account_id not set in ${where}`);
  if (!db?.database_id)
    throw new Error(`no ${DB_BINDING} d1 database with a database_id in ${where}`);
  return {
    accountId: config.account_id,
    databaseId: db.database_id,
    databaseName: db.database_name ?? db.database_id,
  };
}
