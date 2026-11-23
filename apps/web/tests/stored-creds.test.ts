import { describe, expect, it } from "vitest";
import { readStoredCreds } from "@/lib/server/creds";

describe("readStoredCreds", () => {
  it("normal map: read as is", () => {
    expect(readStoredCreds(JSON.stringify({ apiKey: "k", secret: "密文" }))).toEqual({
      apiKey: "k",
      secret: "密文",
    });
  });

  it('null / empty string (never filled in): empty map, not null: "not filled" and "broken" are different things', () => {
    expect(readStoredCreds(null)).toEqual({});
    expect(readStoredCreds(undefined)).toEqual({});
    expect(readStoredCreds("")).toEqual({});
  });

  it("unparsable JSON: null, no throw", () => {
    expect(readStoredCreds("{这不是 JSON")).toBeNull();
    expect(readStoredCreds("{")).toBeNull();
  });

  it("valid JSON that is not an object: also counts as unparsable", () => {
    expect(readStoredCreds('"就是个字符串"')).toBeNull();
    expect(readStoredCreds("123")).toBeNull();
    expect(readStoredCreds("null")).toBeNull();
    expect(readStoredCreds("[]")).toBeNull();
  });
});
