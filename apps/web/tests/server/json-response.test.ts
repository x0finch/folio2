import { InvalidInput } from "@folio/db";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { readJson } from "@/lib/core/json-response";
import { runEffectJson } from "@/lib/server/runtime";

describe("runEffectJson", () => {
  const ctx = { data: { n: 2 }, context: { userId: "user-json" } };

  it("success: JSON Response that decodes back to the handler's return value", async () => {
    const handler = Effect.fn("jsonOk")(function* (data: { n: number }) {
      return yield* Effect.succeed({
        rows: [["a", data.n, null]],
        sampled: true,
        nested: { x: 1.5 },
      });
    });

    const res = await runEffectJson(handler)(ctx);

    expect(res).toBeInstanceOf(Response);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await readJson(res)).toEqual({
      rows: [["a", 2, null]],
      sampled: true,
      nested: { x: 1.5 },
    });
  });

  it("failure: throws as before (Start serializes it as an error), never builds a 200", async () => {
    const handler = Effect.fn("jsonFail")(function* (_: { n: number }) {
      return yield* Effect.fail(new InvalidInput({ what: "test", why: "nope" }));
    });

    await expect(runEffectJson(handler)(ctx)).rejects.toThrow();
  });
});
