import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { CurrentUser } from "../current-user";
import { userSettings } from "../schema";
import type { UserSettings, ValuationMode } from "../schema/types";
import { DbClient } from "../stores/service";

// 用户设置(Phase 3,#82)。

// 缺省:无行的用户 → self-first(= 旧行为)。db 层不耦合 @folio/oracle,就地写常量。
// 运行时换价源(active_vendor)已废止(ADR 0014)—— CoinGecko 单源,仅留估值模式。
const DEFAULT_VALUATION_MODE: ValuationMode = "self-first";

export interface UserSettingsView {
  valuationMode: ValuationMode;
}

const make = Effect.gen(function* () {
  const database = yield* DbClient;
  const userId = yield* CurrentUser;

  return {
    /** 读带缺省:无行返默认(不为每个用户强制建行)。 */
    get: (): Effect.Effect<UserSettingsView> =>
      Effect.map(
        database.query((db) =>
          db.select().from(userSettings).where(eq(userSettings.userId, userId)),
        ),
        (rows) => {
          const r = rows[0] as UserSettings | undefined;
          return { valuationMode: r?.valuationMode ?? DEFAULT_VALUATION_MODE };
        },
      ),

    /** upsert:只覆盖给定字段(缺省字段首次建行用默认值,后续保持原值)。 */
    update: (patch: { valuationMode?: ValuationMode }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = Date.now();
        const set: Partial<{ valuationMode: ValuationMode; updatedAt: number }> = {
          updatedAt: now,
        };
        if (patch.valuationMode !== undefined) set.valuationMode = patch.valuationMode;
        yield* database.query((db) =>
          db
            .insert(userSettings)
            .values({
              userId,
              valuationMode: patch.valuationMode ?? DEFAULT_VALUATION_MODE,
              updatedAt: now,
            })
            .onConflictDoUpdate({ target: userSettings.userId, set }),
        );
      }),
  };
});

export class SettingsStore extends Effect.Service<SettingsStore>()("db/SettingsStore", {
  effect: make,
}) {}
