import { validateCredentials } from "@folio/connectors-basic";
import { describe, expect, it } from "vitest";
import { addressCreds } from "../../src/connectors/address-creds";

// Runs before any fetch; the format is left to the upstream, so only non-empty.
describe("address creds", () => {
  it("accepts a non-empty address (after trim)", async () => {
    await expect(validateCredentials(addressCreds, { address: " abc " })).resolves.toEqual({
      address: "abc",
    });
  });

  it("rejects an empty / missing address", async () => {
    await expect(validateCredentials(addressCreds, { address: "  " })).rejects.toThrow(/address/);
    await expect(validateCredentials(addressCreds, {})).rejects.toThrow(/address/);
  });
});
