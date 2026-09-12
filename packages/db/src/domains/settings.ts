import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { DbClient } from "../client";
import { CurrentUser } from "../current-user";
import { userSettings } from "../schema";
import type { UserSettings, ValuationMode } from "../schema/types";

// 用户设置(Phase 3,#82)。

// 缺省:无行的用户 → self-first(= 旧行为)。db 层不耦合 @folio/oracle,就地写常量。
// 运行时换价源(active_vendor)已废止(ADR 0014)—— CoinGecko 单源,仅留估值模式。
const DEFAULT_VALUATION_MODE: ValuationMode = "self-first";
// 隐私开关缺省关(ADR 0052)。无行的用户读出 false;fail-closed 是客户端在设置到达前的事,不是这里。
const DEFAULT_HIDE_BALANCES = false;

export interface UserSettingsView {
  valuationMode: ValuationMode;
  hideBalances: boolean;
}

export const makeSettingsStore = Effect.gen(function* () {
  const client = yield* DbClient;
  const userId = yield* CurrentUser;

  return {
    /** 读带缺省:无行返默认(不为每个用户强制建行)。 */
    get: (): Effect.Effect<UserSettingsView> =>
      Effect.map(
        client.query((db) => db.select().from(userSettings).where(eq(userSettings.userId, userId))),
        (rows) => {
          const r = rows[0] as UserSettings | undefined;
          return {
            valuationMode: r?.valuationMode ?? DEFAULT_VALUATION_MODE,
            hideBalances: r?.hideBalances ?? DEFAULT_HIDE_BALANCES,
          };
        },
      ),

    /** upsert:只覆盖给定字段(缺省字段首次建行用默认值,后续保持原值)。 */
    update: (patch: {
      valuationMode?: ValuationMode;
      hideBalances?: boolean;
    }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = Date.now();
        const set: Partial<{
          valuationMode: ValuationMode;
          hideBalances: boolean;
          updatedAt: number;
        }> = { updatedAt: now };
        if (patch.valuationMode !== undefined) set.valuationMode = patch.valuationMode;
        if (patch.hideBalances !== undefined) set.hideBalances = patch.hideBalances;
        yield* client.query((db) =>
          db
            .insert(userSettings)
            .values({
              userId,
              valuationMode: patch.valuationMode ?? DEFAULT_VALUATION_MODE,
              hideBalances: patch.hideBalances ?? DEFAULT_HIDE_BALANCES,
              updatedAt: now,
            })
            .onConflictDoUpdate({ target: userSettings.userId, set }),
        );
      }),
  };
});
