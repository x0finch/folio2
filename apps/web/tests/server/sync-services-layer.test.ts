import { env } from "cloudflare:test";
import type { Balance } from "@folio/connectors-basic";
import { Database } from "@folio/db";
import { Account, BalanceSource, AccountStore as SyncAccountStore } from "@folio/sync";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "@/lib/server/errors";
import { runForUser, type UserServices } from "@/lib/server/runtime";
import { makeSyncServicesLayer } from "@/lib/server/sync/deps";
import { dbFor } from "./db-effect";

// App-side wiring of `@folio/sync`'s four capabilities (`makeSyncServicesLayer()`). Other cases test orchestration with
// "fetch balances" as background; this layer's own jobs are the four Tags' wiring, the shared seed collector, lazy valuation-mode
// reads and translating db defects into `SyncDepError` (without which one user's D1 hiccup silently takes down the whole cron round).
// Real D1 (Miniflare) and the real reference layer; only "fetch balances", the one step that goes outbound, is faked.

const USER = "user-sync-services-layer";

// Production handler: the same kernel server fns and routes use.
const run = <A, E extends AppError, R extends UserServices>(
  userId: string,
  effect: Effect.Effect<A, E, R>,
): Promise<A> => runForUser(userId, effect);

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}

beforeEach(async () => {
  await resetUser();
  // This path never goes outbound by design (mint uses the local mapping table / catalogue); an outbound call should make the case fail loudly.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`must not go outbound, but requested ${String(input)}`);
  });
});

// Fake "fetch balances"; the other three capabilities stay real wiring. `Effect.provide` resolves inside-out, so this
// layer satisfies `BalanceSource` first. Written against the real type (no `as never`): a cast once hid a missing `tokenRef`,
// which `toSnapshotRows` needs for platform and only blew up at runtime.
const fakeBalances = (rows: Balance[]) =>
  Layer.succeed(BalanceSource, {
    fetch: () =>
      Effect.succeed({
        status: "ok" as const,
        balances: rows,
        totalUsd: rows.reduce((sum, b) => sum + b.value, 0),
      }),
  });

const USDC_ETH = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

describe("makeSyncServicesLayer() wiring", () => {
  it("syncing one account -> snapshot persisted, total and identity correct", async () => {
    const account = await dbFor(USER).accounts.create({
      connectorId: "evm",
      label: "W",
      creds: null,
    });

    const result = await run(
      USER,
      Account.syncAccount(USER, account, null).pipe(
        Effect.provide(
          fakeBalances([
            { symbol: "USDC", amount: 2, value: 50, kind: "spot", tokenRef: USDC_ETH },
          ]),
        ),
        Effect.provide(makeSyncServicesLayer()),
      ),
    );

    expect(result.ok).toBe(true);
    const rows = await dbFor(USER).snapshots.listByAccount(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalUsd).toBe(50);
    // Mint ran through the real reference layer: the snapshot row carries an identity (whether upstream recognizes it is separate; only a token_id is needed).
    const balances = await dbFor(USER).snapshots.balancesFor([rows[0].id]);
    expect(balances[0].tokenId).toBeTruthy();
  });

  // The hour-collapse switch is wired by this layer: `SnapshotStore.write` appends by default and the sync path turns collapse on.
  // This pins that the flag is passed; collapse correctness belongs to packages/db's `snapshot-hour-collapse`. The clock must be
  // pinned: `syncAccount` reads `Date.now()` (not Effect's Clock), so wall-clock would flake when two syncs straddle the hour.
  it("two syncs within the same hour -> only the last snapshot is kept", async () => {
    const account = await dbFor(USER).accounts.create({
      connectorId: "evm",
      label: "W",
      creds: null,
    });
    const hour = Math.floor(1_800_000_000_000 / 3_600_000) * 3_600_000;
    const now = vi.spyOn(Date, "now");

    const sync = (at: number, value: number) => {
      now.mockReturnValue(at);
      return run(
        USER,
        Account.syncAccount(USER, account, null).pipe(
          Effect.provide(
            fakeBalances([{ symbol: "USDC", amount: 2, value, kind: "spot", tokenRef: USDC_ETH }]),
          ),
          Effect.provide(makeSyncServicesLayer()),
        ),
      );
    };

    await sync(hour + 5 * 60_000, 50);
    await sync(hour + 35 * 60_000, 80);

    const rows = await dbFor(USER).snapshots.listByAccount(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalUsd).toBe(80);
  });

  // db failures must be typed `SyncDepError`, not defects: the db store's error channel is `never` (D1 down = defect), while
  // orchestration isolation relies on typed failures (`bestEffort` and the `catchAll` at the end of `syncAccount` catch only that);
  // without this translation one user's D1 hiccup would take down the whole cron round as a defect.
  it("db down -> typed failure, not a defect (only then can cron isolate it)", async () => {
    const exit = await run(
      USER,
      Effect.flatMap(SyncAccountStore, (s) => s.list()).pipe(
        Effect.provide(makeSyncServicesLayer()),
        // Inject a db aggregate that dies (real D1 can't be made to fail); only `accounts.list` is reached, other fields needn't be built.
        Effect.provide(
          Layer.succeed(Database, {
            accounts: { list: () => Effect.die(new Error("d1 down")) },
          } as never),
        ),
        Effect.exit,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // What matters is a failure, not a defect: the kind `catchAll` can catch.
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
    expect(Option.isSome(failure)).toBe(true);
    expect((Option.getOrThrow(failure) as { _tag: string })._tag).toBe("SyncDepError");
  });

  // Archived accounts yield no new snapshots and manual is not a sync source; this layer's `list()` filters both out,
  // so orchestration never sees them (wiring's job, not orchestration's).
  it("`list()` only hands out active syncable accounts", async () => {
    const live = await dbFor(USER).accounts.create({ connectorId: "evm", label: "L", creds: null });
    const archived = await dbFor(USER).accounts.create({
      connectorId: "evm",
      label: "A",
      creds: null,
    });
    await dbFor(USER).accounts.setArchived(archived.id, true);
    await dbFor(USER).accounts.create({ connectorId: "manual", label: "M", creds: null });

    const listed = await run(
      USER,
      Effect.flatMap(SyncAccountStore, (s) => s.list()).pipe(
        Effect.provide(makeSyncServicesLayer()),
      ),
    );

    expect(listed.map((a) => a.id)).toEqual([live.id]);
  });

  // The round's account list is computed once by the server: opening a round fixes it from the current portfolio and writes it
  // into the round record, and this layer runs exactly that list, so the panel's `x / N` and the real run count are one list.
  it("given a list -> `list()` only hands out accounts on it", async () => {
    const def = await dbFor(USER).portfolios.ensureDefault();
    const watch = await dbFor(USER).portfolios.create({ name: "Watch" });
    const mine = await dbFor(USER).accounts.create({
      connectorId: "evm",
      label: "Mine",
      creds: null,
    });
    const watched = await dbFor(USER).accounts.create({
      connectorId: "evm",
      label: "Watch only",
      creds: null,
    });
    await dbFor(USER).portfolios.assignAccount(mine.id, def.id);
    await dbFor(USER).portfolios.assignAccount(watched.id, watch.id);

    const listOf = (only: ReadonlySet<string>) =>
      run(
        USER,
        Effect.flatMap(SyncAccountStore, (s) => s.list()).pipe(
          Effect.provide(makeSyncServicesLayer({ only })),
        ),
      );

    expect((await listOf(new Set([watched.id]))).map((a) => a.id)).toEqual([watched.id]);
    expect((await listOf(new Set([mine.id]))).map((a) => a.id)).toEqual([mine.id]);
    // Without a list, the full set is returned.
    const all = await run(
      USER,
      Effect.flatMap(SyncAccountStore, (s) => s.list()).pipe(
        Effect.provide(makeSyncServicesLayer()),
      ),
    );
    expect(all.map((a) => a.id).sort()).toEqual([mine.id, watched.id].sort());
  });
});
