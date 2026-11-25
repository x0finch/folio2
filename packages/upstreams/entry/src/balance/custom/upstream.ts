import type { Note } from "@folio/connectors-basic";
import { UpstreamAuthError, UpstreamParseError, UpstreamRefusedError } from "@folio/upstream-basic";
import { Effect, Schema } from "effect";
import { balanceUpstream } from "../../runtime/balance";
import { type Call, defineUpstream } from "../../runtime/define";
import { fetchRows, type Incomplete } from "./api";
import { CustomConfig, configNeeds, hostOfOrigin, hostProblem } from "./config";
import { ID, MAX_BODY_BYTES, MAX_PAGES, OWN_ORIGIN } from "./constants";
import { parseRows } from "./parse";

const custom = defineUpstream({
  id: ID,
  label: "Custom source",
  optionalKeys: [OWN_ORIGIN],
  publicKeys: [OWN_ORIGIN],
  headers: () => ({ accept: "application/json" }),
  refuseRedirects: true,
  maxBodyBytes: MAX_BODY_BYTES,
});

const Account = Schema.Struct({
  config: CustomConfig,
  apiKey: Schema.optional(Schema.String),
  address: Schema.optional(Schema.String),
});
type Account = typeof Account.Type;

const refused = (cause: string) =>
  new UpstreamRefusedError({ upstream: ID, where: "(config)", cause });

// Checked on every call, not only when saved: a config stored before a rule existed, or one that
// only now points at this deployment, must still never be fetched.
const checkTarget = (call: Call<never, typeof OWN_ORIGIN>, { config, address }: Account) =>
  Effect.gen(function* () {
    // Without it the own-domain rule can't run; the other host rules still do.
    if (!call.keys[OWN_ORIGIN]) {
      yield* Effect.logWarning(`custom source: ${OWN_ORIGIN} unset, own domain not checked`);
    }
    return yield* checkRules(call, { config, address });
  });

const checkRules = (call: Call<never, typeof OWN_ORIGIN>, { config, address }: Account) => {
  const problem = hostProblem(config.host, hostOfOrigin(call.keys[OWN_ORIGIN]));
  if (problem) return Effect.fail(refused(`host: ${problem}`));
  const wantsAddress = configNeeds(config).address;
  if (wantsAddress && !address?.trim()) return Effect.fail(refused("config needs an address"));
  // Encoding leaves dots alone, and the URL parser would resolve them as a segment of the path.
  if (wantsAddress && /^\.+$/.test(address?.trim() ?? "")) {
    return Effect.fail(refused("address can't be only dots"));
  }
  return Effect.void;
};

// Page pagination can't tell a full last page from one more to come without another request.
const incompleteNote = (why: Incomplete): Note => ({
  title: "Some pages may not have been read",
  icon: "warning",
  content:
    why === "page-cap"
      ? `Only the first ${MAX_PAGES} pages of this source are read.`
      : "The source sent a page it had already sent, so reading stopped there.",
});

export const customBalance = balanceUpstream(custom, {
  account: Account,
  base: ({ config }) => `https://${config.host}`,
  fetch: (call, { creds }) =>
    Effect.gen(function* () {
      yield* checkTarget(call, creds);
      if ((creds.config.auth ?? "none") !== "none" && !creds.apiKey) {
        return yield* new UpstreamAuthError({ upstream: ID, where: "(account)", cause: "no key" });
      }
      const { rows, incomplete } = yield* fetchRows(call, creds);
      const { balances, readable } = parseRows(rows, creds.config);
      // Rows came back but the fields named none of them: the config, not the holdings, is wrong.
      if (rows.length > 0 && readable === 0) {
        return yield* new UpstreamParseError({
          upstream: ID,
          where: "(config)",
          cause: "no row has the configured symbol and amount",
        });
      }
      return { balances, ...(incomplete ? { note: [incompleteNote(incomplete)] } : {}) };
    }),
  // Sources run only inside sync jobs: adding the account checks the config, never the network.
  verify: (call, { creds }) => checkTarget(call, creds),
});
