import { validateCredentials } from "@folio/connectors-basic";
import { describe, expect, it } from "vitest";
import { bitcoinAccountCreds } from "../../../src/connectors/bitcoin/creds";

const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ZPUB84 =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

describe("addressOrXpub validation (account.creds validator)", () => {
  const accept = (id: string, extra: Record<string, string> = {}) =>
    validateCredentials(bitcoinAccountCreds, { addressOrXpub: id, ...extra });
  const reject = (id: string) => expect(accept(id)).rejects.toThrow(/addressOrXpub/);

  it("accepts addresses + xpub/ypub/zpub; scriptType optional", async () => {
    await expect(accept("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).resolves.toBeDefined();
    await expect(accept("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).resolves.toBeDefined();
    await expect(accept(ZPUB84)).resolves.toBeDefined();
    await expect(accept(ADDR, { scriptType: "taproot" })).resolves.toBeDefined();
  });

  it("rejects EVM 0x / junk", async () => {
    await reject("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    await reject("not-an-address");
  });
});
