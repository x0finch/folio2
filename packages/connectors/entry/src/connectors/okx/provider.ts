import type {
  BalanceProvider,
  CredField,
  Note,
  ProviderNeeds,
  Spot,
} from "@folio/connectors-basic";
import {
  make as makeOkxClient,
  OKX_API_BASE,
  type OkxClientApi,
  type OkxCreds,
  type OkxDetail,
} from "@folio/okx-client";
import type { UpstreamError } from "@folio/upstream-basic";
import { Effect } from "effect";
import { z } from "zod";
import { bestEffortVerdict } from "../../upstream";
import { PROVIDER_ID } from "./constants";
import {
  bucketFailureNote,
  buildPriceHint,
  classicNote,
  earnResidualRow,
  parseBalances,
  parseFunding,
  parseSavings,
  parseStaking,
  perpNote,
} from "./parse";

// apiKey is an identifier sent in plain headers (semi); secret and passphrase sign requests.
export const okxAccountCreds = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
  { key: "passphrase", type: "secret", label: "Passphrase", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

// Optional proxy base, injected from env like the other CEX overrides.
const OKX_BASE_KEY = "OKX_API_BASE";
const baseFrom = (creds: Record<string, unknown>): string => {
  const v = creds[OKX_BASE_KEY];
  return typeof v === "string" && v.trim() ? v.trim() : OKX_API_BASE;
};

// Names go into the failure note, so they live with the fetch.
interface Bucket {
  readonly name: string;
  readonly rows: (
    client: OkxClientApi,
    creds: OkxCreds,
  ) => Effect.Effect<unknown, UpstreamError, ProviderNeeds>;
}

const TRADING: Bucket = { name: "Trading", rows: (c, creds) => c.balance(creds) };
const FUNDING: Bucket = {
  name: "Funding",
  rows: (c, creds) => c.fundingBalances(creds),
};
const SAVINGS: Bucket = {
  name: "Savings",
  rows: (c, creds) => c.savingsBalance(creds),
};
const STAKING: Bucket = {
  name: "Staking",
  rows: (c, creds) => c.stakingOrders(creds),
};

// Valuation and positions aren't balance sources, so they don't count toward "all failed".
const BUCKETS: readonly Bucket[] = [TRADING, FUNDING, SAVINGS, STAKING];

const withClient = <A, E>(
  creds: Record<string, unknown>,
  use: (client: OkxClientApi) => Effect.Effect<A, E, ProviderNeeds>,
): Effect.Effect<A, E, ProviderNeeds> => use(makeOkxClient({ apiBase: baseFrom(creds) }));

export const okxProvider: BalanceProvider<Spot, typeof okxAccountCreds> = {
  id: PROVIDER_ID,
  label: "OKX",
  // Not real credentials: an env-injected base override. May embed a proxy key: never log it.
  creds: [
    {
      key: OKX_BASE_KEY,
      type: "public",
      label: "API base URL",
      validator: z.string().trim().url(),
    },
  ],

  fetchBalances: (ctx) =>
    withClient(ctx.creds, (client) =>
      Effect.gen(function* () {
        const creds = ctx.account.creds;

        // Business errors (HTTP 200 + code ≠ "0") are already failures from the client.
        const [buckets, valuation, positions] = yield* Effect.all(
          [
            Effect.all(
              BUCKETS.map((bucket) =>
                Effect.result(bucket.rows(client, creds)).pipe(
                  Effect.map((result) => ({ bucket, result })),
                ),
              ),
              { concurrency: "unbounded" },
            ),
            // Soft signals: failure just drops their notes this round.
            Effect.result(client.assetValuation(creds)),
            Effect.result(client.positions(creds)),
          ],
          { concurrency: "unbounded" },
        );

        const failed = yield* Effect.fromResult(bestEffortVerdict(buckets));

        const bodyOf = <T>(bucket: Bucket): T | undefined => {
          const hit = buckets.find((b) => b.bucket === bucket);
          return hit?.result._tag === "Success" ? (hit.result.success as T) : undefined;
        };

        const details: OkxDetail[] =
          bodyOf<{ data?: { details?: OkxDetail[] }[] }>(TRADING)?.data?.[0]?.details ?? [];
        // Trading prices value funding/earn rows; if trading failed those wait for the oracle.
        const hint = buildPriceHint(details);

        const earnItems = [
          ...parseSavings(bodyOf<{ data?: never[] }>(SAVINGS)?.data ?? [], hint),
          ...parseStaking(bodyOf<{ data?: never[] }>(STAKING)?.data ?? [], hint),
        ];
        const balances: Spot[] = [
          ...parseBalances(details),
          ...parseFunding(bodyOf<{ data?: never[] }>(FUNDING)?.data ?? [], hint),
          ...earnItems,
        ];

        const notes: Note[] = [];
        if (failed.length) {
          notes.push(
            bucketFailureNote(
              failed.map((f) => ({
                name: f.bucket.name,
                auth: f.result._tag === "Failure" && f.result.failure._tag === "UpstreamAuthError",
              })),
            ),
          );
        }

        if (valuation._tag === "Success") {
          // The residual is only meaningful if both earn buckets were fetched.
          const earnComplete = !failed.some((f) => f.bucket === SAVINGS || f.bucket === STAKING);
          if (earnComplete) {
            const earnBucketUsd = Number(valuation.success.data?.[0]?.details?.earn ?? 0);
            if (earnBucketUsd > 0) {
              const row = earnResidualRow(earnBucketUsd, earnItems, hint);
              if (row) balances.push(row);
            }
          }
          const cn = classicNote(valuation.success);
          if (cn) notes.push(cn);
        }

        if (positions._tag === "Success") {
          const pn = perpNote(positions.success);
          if (pn) notes.push(pn);
        }

        return { balances, note: notes.length ? notes : undefined };
      }),
    ),

  // OKX signals bad credentials as HTTP 200 + code 50xxx; the client maps those to auth.
  validateAccount: (ctx) =>
    withClient(ctx.creds, (client) =>
      client.balance(ctx.account.creds).pipe(
        Effect.as(true),
        Effect.catchTag("UpstreamAuthError", () => Effect.succeed(false)),
      ),
    ),
};
