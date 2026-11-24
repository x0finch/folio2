import { describe, expect, it } from "vitest";
import * as db from "../src";

const surface = db as Record<string, unknown>;

describe("@folio/db encapsulation", () => {
  it("does not expose the drizzle instance, schema, getDb, or raw tables", () => {
    expect(surface.getDb).toBeUndefined();
    expect(surface.schema).toBeUndefined();
    expect(surface.accounts).toBeUndefined(); // no raw table handle
    expect(surface.drizzle).toBeUndefined();
  });

  // Exports are per-user services: a name that is both Tag and layer (`Effect.Service`), with no userId in signatures (read from `CurrentUser` at op time).
  it("exposes per-user store services + global infra, not a facade or raw query functions", () => {
    expect(surface.createDb).toBeUndefined();
    // `Context.Service` yields a class (typeof function); `.layer` is its layer, parameterless: userId comes from `CurrentUser`.
    expect(typeof db.Database).toBe("function");
    expect(typeof db.Database.layer).toBe("object");
    // Per-domain Tags no longer leave the package: domains are reached only via the aggregate.
    expect(surface.AccountStore).toBeUndefined();
    expect(surface.SnapshotStore).toBeUndefined();
    expect(surface.TransferStore).toBeUndefined();
    // `CurrentUser` is exported as a type only; the only way to supply a user is the combinator, which only the assembly point may use.
    expect(surface.CurrentUser).toBeUndefined();
    expect(typeof db.provideCurrentUser).toBe("function");
    // Global infra not scoped by userId: exported on its own.
    expect(typeof db.createAuthAdapter).toBe("function");
    // Raw query functions aren't exported; reachable only through services.
    expect(surface.createAccount).toBeUndefined();
    expect(surface.writeSnapshot).toBeUndefined();
    expect(surface.getLatestSnapshotByUser).toBeUndefined();
  });

  it("hands out one ticket per half: Database for the domains, oraclePortsLayer for the ports", () => {
    // One ticket for all domains; `.layer` needs nothing (built once per isolate); ops' `R` is `DbClient | CurrentUser`.
    expect(typeof db.Database).toBe("function");
    expect(typeof db.Database.layer).toBe("object");
    // Second ticket: ops with no owner (global ref index + cron user scan); `R` is only `DbClient`, so no user data is reachable.
    expect(typeof db.GlobalDatabase).toBe("function");
    expect(typeof db.GlobalDatabase.layer).toBe("object");
    // `DbClient` is exported as a type only: exporting the class would let outside code build arbitrary queries.
    expect(surface.DbClient).toBeUndefined();
    expect(typeof db.provideDbClient).toBe("function");
    // Oracle ticket, for `@folio/oracle` only. `.Default` takes the namer (db has no vendor).
    expect(typeof db.DatabaseForOracle).toBe("function");
    expect(typeof db.DatabaseForOracle.layer("coingecko")).toBe("object");
    // The layer-style export was removed: the contract is the implementation.
    expect(surface.oraclePortsLayer).toBeUndefined();
    expect(surface.userTokenStoreLayer).toBeUndefined();
    expect(surface.userCacheStoreLayer).toBeUndefined();
    // The two paths without userId live on `GlobalDatabase`, not as their own exports.
    expect(surface.globalTokenRefIndexStoreLayer).toBeUndefined();
    expect(surface.listUserIdsWithAccounts).toBeUndefined();
    // Typed failures.
    expect(typeof db.NotFound).toBe("function");
    expect(new db.NotFound({ entity: "account", id: "a1" }).message).toBe("account not found: a1");
    expect(typeof db.InvalidInput).toBe("function");
    expect(new db.InvalidInput({ what: "tab pin", why: "requires tagId" }).message).toBe(
      "tab pin: requires tagId",
    );
  });
});
