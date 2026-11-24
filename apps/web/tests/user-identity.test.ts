import { describe, expect, it } from "vitest";
import { userIdentity } from "@/routes/_authed/-settings/user-card";

describe("userIdentity", () => {
  it("name + email: name on the main row, email on the sub row", () => {
    expect(userIdentity({ name: "Ada Lovelace", email: "ada@folio.dev" })).toEqual({
      primary: "Ada Lovelace",
      secondary: { kind: "email", value: "ada@folio.dev" },
      initial: "A",
    });
  });

  it('no name (empty string): main row falls back to email, sub row "Self-hosted"', () => {
    expect(userIdentity({ name: "", email: "ada@folio.dev" })).toEqual({
      primary: "ada@folio.dev",
      secondary: { kind: "selfHosted" },
      initial: "A",
    });
  });

  it("name null: also falls back to email", () => {
    expect(userIdentity({ name: null, email: "bob@folio.dev" })).toEqual({
      primary: "bob@folio.dev",
      secondary: { kind: "selfHosted" },
      initial: "B",
    });
  });

  it('name but no email: main row name, sub row "Self-hosted"', () => {
    expect(userIdentity({ name: "Grace", email: "" })).toEqual({
      primary: "Grace",
      secondary: { kind: "selfHosted" },
      initial: "G",
    });
  });

  it("neither name nor email: fallback placeholder (no throw)", () => {
    expect(userIdentity({ name: null, email: null })).toEqual({
      primary: "?",
      secondary: { kind: "selfHosted" },
      initial: "?",
    });
  });

  it("initial takes the first character of primary, uppercased; surrounding whitespace trimmed first", () => {
    expect(userIdentity({ name: "  zoe  ", email: "z@folio.dev" })).toEqual({
      primary: "zoe",
      secondary: { kind: "email", value: "z@folio.dev" },
      initial: "Z",
    });
  });
});
