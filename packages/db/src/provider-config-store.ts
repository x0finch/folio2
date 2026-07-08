import { and, eq, ne } from "drizzle-orm";
import { type DbEnv, getDb } from "./client";
import { providerConfig } from "./schema";

// provider 全局配置覆盖表的 D1 实现(ADR 0009;全局,无 userId)。
// 行 = 偏离 manifest 默认的覆盖;空表 = 各 provider 按默认。settings 是 sealed JSON(app 侧 seal/open,
// 本 store 只当不透明字符串存取 —— 不碰 SECRETS_KEY)。

export interface ProviderConfigRow {
  providerId: string;
  accountType: string;
  enabled: boolean | null; // null = 不覆盖启停(仅存 settings)
  settings: string | null; // sealed JSON(secret 字段密文)
}

export interface ProviderConfigStore {
  /** 全部覆盖行(表极小,整读;解析层按 providerId 索引)。 */
  getAll(): Promise<ProviderConfigRow[]>;
  /**
   * 启用(兼作该 type 的选中,ADR 0009):原子批 —— 同 type 其它 enabled=true 的行置 false
   * (切换即替换,每 type 至多一条 true),本行 upsert enabled=true(给了 settings 则一并写)。
   */
  enable(providerId: string, accountType: string, settings?: string | null): Promise<void>;
  /** 显式停用(保留 settings,重新启用时无需重填)。 */
  disable(providerId: string, accountType: string): Promise<void>;
  /** 只写 settings,不动启停(无行则插入 enabled=NULL = 不覆盖)。null = 清除自定义、回落默认。 */
  putSettings(providerId: string, accountType: string, settings: string | null): Promise<void>;
}

export function createProviderConfigStore(env: DbEnv): ProviderConfigStore {
  const db = getDb(env);
  return {
    async getAll() {
      return db.select().from(providerConfig);
    },

    async enable(providerId, accountType, settings) {
      const insertValues = {
        providerId,
        accountType,
        enabled: true,
        ...(settings !== undefined ? { settings } : {}),
      };
      await db.batch([
        // 同 type 其它选中者退位(原子:与本行 upsert 同批)。
        db
          .update(providerConfig)
          .set({ enabled: false })
          .where(
            and(
              eq(providerConfig.accountType, accountType),
              eq(providerConfig.enabled, true),
              ne(providerConfig.providerId, providerId),
            ),
          ),
        db
          .insert(providerConfig)
          .values(insertValues)
          .onConflictDoUpdate({
            target: providerConfig.providerId,
            set: { enabled: true, ...(settings !== undefined ? { settings } : {}) },
          }),
      ]);
    },

    async disable(providerId, accountType) {
      await db
        .insert(providerConfig)
        .values({ providerId, accountType, enabled: false })
        .onConflictDoUpdate({ target: providerConfig.providerId, set: { enabled: false } });
    },

    async putSettings(providerId, accountType, settings) {
      await db
        .insert(providerConfig)
        .values({ providerId, accountType, enabled: null, settings })
        .onConflictDoUpdate({ target: providerConfig.providerId, set: { settings } });
    },
  };
}
