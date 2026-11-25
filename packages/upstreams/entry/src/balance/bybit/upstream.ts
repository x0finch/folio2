import type { Spot } from "@folio/connectors-basic";
import { Effect } from "effect";
import { balanceUpstream } from "../../runtime/balance";
import { failedBucketsNote, fetchBuckets } from "../../runtime/buckets";
import { defineUpstream } from "../../runtime/define";
import { BybitCreds, earnPositions, fundingBalances, walletBalance } from "./api";
import {
  BYBIT_API_BASE,
  BYBIT_API_BASE_OVERRIDE,
  EARN_CATEGORY_FLEXIBLE,
  EARN_CATEGORY_ONCHAIN,
  ID,
} from "./constants";
import { buildPriceHint, parseEarn, parseFunding, parseUnified, perpFallbackNote } from "./parse";

// No deployment key: every request is signed with the account's own key.
const bybit = defineUpstream({
  id: ID,
  label: "Bybit",
  base: BYBIT_API_BASE,
  baseOverride: BYBIT_API_BASE_OVERRIDE,
});

export const bybitBalance = balanceUpstream(bybit, {
  account: BybitCreds,

  fetch: (call, { creds }) =>
    Effect.gen(function* () {
      const { ok, failed } = yield* fetchBuckets({
        Unified: walletBalance(call, creds),
        Funding: fundingBalances(call, creds),
        "Earn (Flexible)": earnPositions(call, creds, EARN_CATEGORY_FLEXIBLE),
        "Earn (On-chain)": earnPositions(call, creds, EARN_CATEGORY_ONCHAIN),
      });

      const unified = ok.Unified?.result?.list?.[0];
      const coins = unified?.coin ?? [];
      // Unified prices value funding / earn rows; without them those wait for the oracle.
      const hint = buildPriceHint(coins);
      const balances: Spot[] = [
        ...parseUnified(coins),
        ...parseFunding(ok.Funding?.result?.balance ?? [], hint),
        ...parseEarn(ok["Earn (Flexible)"]?.result?.list ?? [], "Flexible", hint),
        ...parseEarn(ok["Earn (On-chain)"]?.result?.list ?? [], "On-chain", hint),
      ];

      const upl = Number(unified?.totalPerpUPL ?? 0);
      const note = [
        failedBucketsNote("Buckets not synced", failed),
        unified && upl !== 0 ? perpFallbackNote(upl) : undefined,
      ].filter((n) => n !== undefined);
      return { balances, note: note.length ? note : undefined };
    }),

  // Bad credentials come back as HTTP 200 + a 1000x retCode, which `api.ts` maps to auth.
  verify: (call, { creds }) => walletBalance(call, creds),
});
