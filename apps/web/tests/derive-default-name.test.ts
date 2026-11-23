import { describe, expect, it } from "vitest";
import { deriveDefaultName } from "@/routes/-login/derive-default-name";

// Default name at sign-up: the email's local part, so identity shows `ada` instead of `ada@folio.dev`.
describe("deriveDefaultName", () => {
  it("takes the part before @", () => {
    expect(deriveDefaultName("ada@folio.dev")).toBe("ada");
  });

  it("no @ → the whole string (user still typing)", () => {
    expect(deriveDefaultName("ada")).toBe("ada");
  });

  it("trims surrounding whitespace first", () => {
    expect(deriveDefaultName("  bob@folio.dev  ")).toBe("bob");
  });

  it("empty string → empty", () => {
    expect(deriveDefaultName("")).toBe("");
  });

  it("multiple @ → first segment", () => {
    expect(deriveDefaultName("weird@name@folio.dev")).toBe("weird");
  });
});
