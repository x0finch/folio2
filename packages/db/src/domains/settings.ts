import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { DbClient } from "../client";
import { userSettings } from "../schema";
import type { UserSettings, ValuationMode } from "../schema/types";

// Kept local rather than imported so db doesn't depend on @folio/oracle.
const DEFAULT_VALUATION_MODE: ValuationMode = "self-first";
// Users without a row read false; failing closed before settings load is the client's job.
const DEFAULT_HIDE_BALANCES = false;

export interface UserSettingsView {
  valuationMode: ValuationMode;
  hideBalances: boolean;
}

export const makeSettingsStore = (client: DbClient, userId: string) => {
  return {
    /** Users without a row get the defaults; no row is created on read. */
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

    /** Overwrites only the given fields; missing ones take defaults on first insert. */
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
};
