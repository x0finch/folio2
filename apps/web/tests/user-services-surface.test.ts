import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as db from "@folio/db";
import { Database, DatabaseForOracle, GlobalDatabase } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { UserServices } from "@/lib/server/runtime";

//
//
describe("surface of UserServices", () => {
  it("the three tickets are inside", () => {
    const inSurface: Effect.Effect<unknown, never, UserServices>[] = [
      Effect.flatMap(Database, (db) => db.accounts.list()),
      Effect.flatMap(Oracle, (o) => o.fx.warm([])),
      Effect.flatMap(Database, (db) => db.cache.get("defi-logo:aave")),
    ];
    expect(inSurface).toHaveLength(3);
  });

  it("the reference-layer ticket is not: the effect fetching it is not a UserServices effect", () => {
    // @ts-expect-error DatabaseForOracle is not on the handler-visible surface
    const tokens: Effect.Effect<unknown, never, UserServices> = Effect.flatMap(
      DatabaseForOracle,
      (db) => db.tokens.getByIds([]),
    );
    // @ts-expect-error same: price rows are reachable only from the reference layer
    const prices: Effect.Effect<unknown, never, UserServices> = Effect.flatMap(
      DatabaseForOracle,
      (db) => db.tokenPrices.getByIds([]),
    );
    expect([tokens, prices]).toHaveLength(2);
  });

  it("the ticket without userId is not either: it belongs to cron, not to a handler", () => {
    // @ts-expect-error GlobalDatabase is assembled by the cron side (server.ts / withGlobalDb)
    const ids: Effect.Effect<unknown, never, UserServices> = Effect.flatMap(GlobalDatabase, (db) =>
      db.accounts.listUserIds(),
    );
    expect(ids).toBeDefined();
  });
});

//
describe("user material exists only at the assembly point", () => {
  it("`CurrentUser` leaves the package as a type only: nothing outside can get a value to `Layer.succeed`", () => {
    // @ts-expect-error `CurrentUser` is an `export type`: using it as a value fails to compile (and it is absent at runtime)
    const tag = db.CurrentUser;
    expect(tag).toBeUndefined();
    expect(typeof db.provideCurrentUser).toBe("function");
  });

  it("`UserJobs` leaves runtime.ts as a type only: outside there is only `enqueueForUser`, no Tag to provide", () => {
    type Runtime = typeof import("@/lib/server/runtime");
    // @ts-expect-error `UserJobs` is an `export type`: the module has no such value
    type Tag = Runtime["UserJobs"];
    const enqueueForUser: keyof Runtime = "enqueueForUser";
    expect(enqueueForUser).toBe("enqueueForUser");
    expect<Tag | undefined>(undefined).toBeUndefined();
    const src = readFileSync(join(__dirname, "../src/lib/server/runtime.ts"), "utf8");
    expect(src).toMatch(/^class UserJobs extends Context\.Tag\("web\/UserJobs"\)/m);
    expect(src).toMatch(/^export type \{ UserJobs \};$/m);
  });

  it("in app source, only runtime.ts mentions `CurrentUser` (incl. `provideCurrentUser`, the Tag key), `provideDbClient` or the `UserJobs` Tag key", () => {
    const src = join(__dirname, "../src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : /\.tsx?$/.test(e.name)
            ? [join(dir, e.name)]
            : [],
      );
    const offenders = walk(src)
      .filter((f) => /CurrentUser|provideDbClient|web\/UserJobs/.test(readFileSync(f, "utf8")))
      .map((f) => relative(src, f));
    expect(offenders).toEqual(["lib/server/runtime.ts"]);
  });
});
