import { BitcoinDeriveError, blockbookXpubParam } from "@folio/bitcoin-derive";
import { UpstreamAuthError, type UpstreamError } from "@folio/upstream-basic";
import { Effect, Schema } from "effect";
import { balanceUpstream } from "../../runtime/balance";
import { defineUpstream } from "../../runtime/define";
import type { Outbound } from "../../runtime/http";
import { address, xpub, xpubSummary } from "./api";
import { BLOCKBOOK_API_BASE_OVERRIDE, BLOCKBOOK_BASES, ID, USER_AGENT } from "./constants";
import {
  buildBtcNote,
  buildXpubMeta,
  effectiveScript,
  isExtendedPubkey,
  toBtcBalances,
  toSats,
} from "./parse";

const [BASE, ...MIRRORS] = BLOCKBOOK_BASES;

const blockbook = defineUpstream({
  id: ID,
  label: "Blockbook",
  base: BASE,
  mirrors: MIRRORS,
  baseOverride: BLOCKBOOK_API_BASE_OVERRIDE,
  userAgent: USER_AGENT,
  headers: () => ({ accept: "application/json" }),
});

// An unparseable extended key is a local credentials failure, not an upstream one.
const derivationIsCredentials = <A, R>(
  effect: Effect.Effect<A, UpstreamError, R>,
): Effect.Effect<A, UpstreamError, R> =>
  Effect.catchDefect(effect, (defect) =>
    defect instanceof BitcoinDeriveError
      ? Effect.fail(
          new UpstreamAuthError({ upstream: ID, where: "(derive)", cause: defect.message }),
        )
      : Effect.die(defect),
  );

export const blockbookBalance = balanceUpstream(blockbook, {
  account: Schema.Struct({
    addressOrXpub: Schema.String,
    scriptType: Schema.optional(Schema.String),
  }),

  fetch: (call, { creds: { addressOrXpub: id, scriptType } }) =>
    derivationIsCredentials(
      Effect.suspend(() => {
        if (!isExtendedPubkey(id)) {
          return address(call, id).pipe(
            Effect.map((res) => {
              const pendingSats = toSats(res.unconfirmedBalance);
              return {
                balances: toBtcBalances(toSats(res.balance), pendingSats),
                note: buildBtcNote(pendingSats),
              };
            }),
          );
        }
        const script = effectiveScript(id, scriptType);
        return xpub(call, blockbookXpubParam(id, script)).pipe(
          Effect.map((res) => {
            const pendingSats = toSats(res.unconfirmedBalance);
            return {
              balances: toBtcBalances(toSats(res.balance), pendingSats),
              note: buildBtcNote(pendingSats, buildXpubMeta(id, script, res.tokens ?? [])),
            };
          }),
        );
      }),
    ),

  // The probe needs no per-address detail.
  verify: (call, { creds: { addressOrXpub: id, scriptType } }) =>
    derivationIsCredentials(
      Effect.suspend(
        (): Effect.Effect<unknown, UpstreamError, Outbound> =>
          isExtendedPubkey(id)
            ? xpubSummary(call, blockbookXpubParam(id, effectiveScript(id, scriptType)))
            : address(call, id),
      ),
    ),
});
