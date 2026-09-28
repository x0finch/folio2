import { unstable_readConfig } from "wrangler";

// 刷哪个远端库:account_id 与 database_id **只写在 `apps/web/wrangler.jsonc` 里一次**,这里照读,不另抄。
//
// 用 wrangler 自己的读法(`unstable_readConfig`)而不是正则抠:它懂 JSONC、懂 `env` 不继承的规矩
// (`--env preview` 拿到的是 `folio-preview` 那个库),与 `wrangler d1 migrations apply` 看到的是同一份。
// `unstable_` 前缀是 wrangler 对 API 稳定性的说法;wrangler 版本在 catalog 里钉着,升级时这里跟着验一次。

/** Worker 里那个 D1 绑定的名字(与 wrangler.jsonc 的 `d1_databases[].binding` 一致)。 */
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
