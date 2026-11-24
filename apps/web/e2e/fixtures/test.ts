import { test as base } from "@playwright/test";
import {
  type AuthenticatorOptions,
  addAuthenticator,
  type VirtualAuthenticator,
} from "./authenticator";

/** Parameter type for helper functions in specs (fixtures are only available inside test callbacks, so helpers take them explicitly). */
export type AddAuth = (opts?: AuthenticatorOptions) => Promise<VirtualAuthenticator>;

interface Fixtures {
  /**
   * Creates a virtual authenticator and tears it down when the test ends.
   * It must be torn down: virtual authenticators hang off the browser, not the context, so closing the context doesn't remove them, and after a few accumulate
   * the ceremony picks the wrong one (symptom: a spec passes alone but a case in the full run can't enable the lock).
   * A factory rather than a plain fixture because tests need different authenticators (platform / USB / no UV) and a fixture takes no parameters.
   */
  addAuth: AddAuth;
}

export const test = base.extend<Fixtures>({
  addAuth: async ({ page }, use) => {
    const created: VirtualAuthenticator[] = [];
    await use(async (opts) => {
      const authenticator = await addAuthenticator(page, opts);
      created.push(authenticator);
      return authenticator;
    });
    // Tear down while the page is alive (fixture teardown runs before the context closes), or CDP calls go nowhere.
    for (const authenticator of created) {
      await authenticator.remove().catch(() => {});
    }
  },
});

export { expect } from "@playwright/test";
