import { env } from "cloudflare:test";
import { Database } from "@folio/db";
import { configure, type LogLevel, type LogRecord, reset } from "@logtape/logtape";
import { Cause, Effect, Exit } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { forUser } from "@/lib/server/runtime";
import { handleCreateTabPin } from "@/lib/server/tab-pins/create";
import { spanTracerTo, withSpanTree } from "@/lib/server/tracing";

// Drives the real chain (real D1 + production assembly) and asserts the tree's shape, never milliseconds.

const USER = "user-tracing";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
});

const treeOf = async <A>(effect: Effect.Effect<A, never, never>): Promise<string> => {
  const trees: string[] = [];
  await Effect.runPromise(effect.pipe(Effect.provide(spanTracerTo((t) => trees.push(t)))));
  expect(trees).toHaveLength(1); // exactly one tree per request
  return trees[0];
};

describe("span tree", () => {
  it("one tree per request, rooted at the handler name + duration + who", async () => {
    const tree = await treeOf(
      forUser(USER, handleCreateTabPin({ kind: "connector", connectorId: "binance" })).pipe(
        Effect.orDie,
      ),
    );
    // The `userId` span annotation must reach the real tree.
    expect(tree.split("\n")[0]).toMatch(/^createTabPin \d+\.\d+ms userId=user-tracing$/);
  });

  // Three layers: handler -> domain op (Database aggregate's `bindPerCall`) -> D1 (`DbClient`).
  it("tree has three layers: handler name -> domain op -> D1", async () => {
    const tree = await treeOf(
      forUser(
        USER,
        Effect.flatMap(Database, (db) => db.tabPins.list()),
      ).pipe(Effect.orDie, Effect.withSpan("listTabPins")),
    );
    const lines = tree.split("\n");
    expect(lines[0]).toMatch(/^listTabPins \d/);
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/^ {2}tabPins\.list \d/),
      expect.stringMatching(/^ {4}db\.query \d/),
    ]);
  });
});

// The switch follows `LOG_LEVEL` (free plan 10ms CPU): `withSpanTree` asks LogTape whether debug lands,
// so LogTape's threshold drives it, same as production (`configureLogging` resolves `lowestLevel`).
describe("span tree is installed only at debug", () => {
  const captured: LogRecord[] = [];
  const logAt = async (lowestLevel: LogLevel) => {
    captured.length = 0;
    await configure({
      reset: true,
      sinks: { capture: (record: LogRecord) => captured.push(record) },
      loggers: [{ category: ["folio"], sinks: ["capture"], lowestLevel }],
    });
  };
  const trees = () =>
    captured
      .filter((r) => r.category.join(".") === "folio.web.trace")
      .map((r) => r.properties.tree);
  const createPin = () =>
    forUser(USER, handleCreateTabPin({ kind: "connector", connectorId: "binance" })).pipe(
      Effect.orDie,
    );

  afterAll(async () => {
    await reset();
  });

  it("LOG_LEVEL=debug -> one tree per request", async () => {
    await logAt("debug");
    await Effect.runPromise(withSpanTree(createPin()));
    expect(trees()).toHaveLength(1);
    expect(String(trees()[0]).split("\n")[0]).toMatch(
      /^createTabPin \d+\.\d+ms userId=user-tracing$/,
    );
  });

  it("LOG_LEVEL=info -> no tree lines", async () => {
    await logAt("info");
    await Effect.runPromise(withSpanTree(createPin()));
    expect(trees()).toEqual([]);
  });

  // Without the tree, Effect tracing is not turned off: a no-op span would break the parent chain and
  // `requireAuth`'s fallback log relies on the outer handler name in the stack.
  it("LOG_LEVEL=info -> error stack still carries the outer handler name", async () => {
    await logAt("info");
    const failing = Effect.fn("outerHandler")(function* () {
      return yield* Effect.fail(new Error("boom")).pipe(Effect.withSpan("inner.op"));
    });
    const exit = await Effect.runPromiseExit(withSpanTree(failing()));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const pretty = Cause.pretty(exit.cause);
      expect(pretty).toContain("at inner.op");
      expect(pretty).toContain("at outerHandler");
    }
  });
});
