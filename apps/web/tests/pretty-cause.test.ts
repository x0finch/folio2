import { describe, expect, it } from "vitest";
import { prettyCauseOf, withPrettyCause } from "@/lib/server/errors";

describe("withPrettyCause", () => {
  it("attaches the cause, and again when the same error is rejected twice", () => {
    const error = new Error("boom");
    withPrettyCause(error, "first");
    expect(() => withPrettyCause(error, "second")).not.toThrow();
    expect(prettyCauseOf(error)).toBe("second");
  });

  it("leaves a frozen error as it is instead of throwing over it", () => {
    const error = Object.freeze(new Error("frozen"));
    expect(withPrettyCause(error, "cause")).toBe(error);
    expect(prettyCauseOf(error)).toBeUndefined();
  });
});
