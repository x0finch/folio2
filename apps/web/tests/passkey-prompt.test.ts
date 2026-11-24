import { describe, expect, it } from "vitest";
import { shouldPromptForPasskey } from "@/routes/-login/passkey-prompt";

// Post-login prompt: shown only when supported + not dismissed + no passkey. localStorage IO is a
// thin wrapper left untested; the pure predicate is the seam.
describe("shouldPromptForPasskey", () => {
  it("supported + not dismissed + no passkey -> prompt", () => {
    expect(shouldPromptForPasskey({ supported: true, dismissed: false, passkeyCount: 0 })).toBe(
      true,
    );
  });
  it("already has a passkey -> no prompt", () => {
    expect(shouldPromptForPasskey({ supported: true, dismissed: false, passkeyCount: 2 })).toBe(
      false,
    );
  });
  it("don't-ask-again chosen -> no prompt", () => {
    expect(shouldPromptForPasskey({ supported: true, dismissed: true, passkeyCount: 0 })).toBe(
      false,
    );
  });
  it("browser unsupported -> no prompt", () => {
    expect(shouldPromptForPasskey({ supported: false, dismissed: false, passkeyCount: 0 })).toBe(
      false,
    );
  });
});
