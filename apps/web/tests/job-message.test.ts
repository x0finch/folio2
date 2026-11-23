import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { decodeJob } from "@/lib/server/jobs/message";

describe("decodeJob", () => {
  const sync = {
    kind: "sync-account",
    userId: "u1",
    portfolioId: "pf1",
    roundId: "r1",
    accountId: "a1",
  };

  it("sync-account decodes as is", () => {
    expect(decodeJob(sync)).toEqual(Either.right(sync));
  });

  it.each([
    "fx",
    "platforms",
    "catalogue",
    "defi-logos",
    "prune-notes",
  ])("%s decodes as is", (kind) => {
    expect(decodeJob({ kind, userId: "u1" })).toEqual(Either.right({ kind, userId: "u1" }));
  });

  it("retired warm-user: Left", () => {
    expect(Either.isLeft(decodeJob({ kind: "warm-user", userId: "u1" }))).toBe(true);
  });

  it("extra fields are dropped: leftovers from older versions never leak into the consumer", () => {
    expect(decodeJob({ ...sync, extra: 1 })).toEqual(Either.right(sync));
  });

  it.each([
    ["unknown kind", { kind: "prices" }],
    ["missing field", { kind: "sync-account", userId: "u1" }],
    ["empty id", { ...sync, accountId: "" }],
    ["wrong type", { ...sync, roundId: 42 }],
    ["not an object", "sync-account"],
    ["null", null],
  ])("%s → Left", (_name, body) => {
    expect(Either.isLeft(decodeJob(body))).toBe(true);
  });

  it("error message does not echo the value", () => {
    const secretish = "user-id-that-must-not-be-logged";
    const out = decodeJob({ ...sync, userId: secretish, accountId: 7 });
    expect(Either.isLeft(out)).toBe(true);
    if (Either.isLeft(out)) expect(out.left).not.toContain(secretish);
  });
});
