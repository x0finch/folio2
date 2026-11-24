import type { Note, Spot } from "@folio/connectors-basic";
import { Effect } from "effect";
import { balanceUpstream } from "../../runtime/balance";
import { failedBucketsNote, fetchBuckets } from "../../runtime/buckets";
import { defineUpstream } from "../../runtime/define";
import {
  assetValuation,
  balance,
  fundingBalances,
  OkxCreds,
  positions,
  savingsBalance,
  stakingOrders,
} from "./api";
import { ID, OKX_API_BASE, OKX_API_BASE_OVERRIDE } from "./constants";
import {
  buildPriceHint,
  classicNote,
  earnResidualRow,
  parseBalances,
  parseFunding,
  parseSavings,
  parseStaking,
  perpNote,
} from "./parse";

// No deployment key: every request is signed with the account's own key.
const okx = defineUpstream({
  id: ID,
  label: "OKX",
  base: OKX_API_BASE,
  baseOverride: OKX_API_BASE_OVERRIDE,
  headers: () => ({ "content-type": "application/json" }),
});

export const okxBalance = balanceUpstream(okx, {
  account: OkxCreds,

  fetch: (call, { creds }) =>
    Effect.gen(function* () {
      const [buckets, valuation, open] = yield* Effect.all(
        [
          fetchBuckets({
            Trading: balance(call, creds),
            Funding: fundingBalances(call, creds),
            Savings: savingsBalance(call, creds),
            Staking: stakingOrders(call, creds),
          }),
          // Not balance sources: a failure only drops their notes this round.
          Effect.result(assetValuation(call, creds)),
          Effect.result(positions(call, creds)),
        ],
        { concurrency: "unbounded" },
      );
      const { ok, failed } = buckets;

      const details = ok.Trading?.data?.[0]?.details ?? [];
      // Trading prices value funding / earn rows; without them those wait for the oracle.
      const hint = buildPriceHint(details);
      const earnItems = [
        ...parseSavings(ok.Savings?.data ?? [], hint),
        ...parseStaking(ok.Staking?.data ?? [], hint),
      ];
      const balances: Spot[] = [
        ...parseBalances(details),
        ...parseFunding(ok.Funding?.data ?? [], hint),
        ...earnItems,
      ];

      const notes: (Note | undefined)[] = [failedBucketsNote("Buckets not synced", failed)];
      if (valuation._tag === "Success") {
        // The residual means something only when both earn buckets were read.
        const earnComplete = ok.Savings !== undefined && ok.Staking !== undefined;
        const earnBucketUsd = Number(valuation.success.data?.[0]?.details?.earn ?? 0);
        if (earnComplete && earnBucketUsd > 0) {
          const row = earnResidualRow(earnBucketUsd, earnItems, hint);
          if (row) balances.push(row);
        }
        notes.push(classicNote(valuation.success));
      }
      if (open._tag === "Success") notes.push(perpNote(open.success));

      const note = notes.filter((n) => n !== undefined);
      return { balances, note: note.length ? note : undefined };
    }),

  // Bad credentials come back as HTTP 200 + a 50xxx code, which `api.ts` maps to auth.
  verify: (call, { creds }) => balance(call, creds),
});
