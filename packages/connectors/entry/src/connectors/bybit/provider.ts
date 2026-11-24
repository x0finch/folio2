import {
  BYBIT_API_BASE,
  type BybitClientApi,
  type BybitCoin,
  type BybitCreds,
  make as makeBybitClient,
} from "@folio/bybit-client";
import type {
  BalanceProvider,
  ConnectorError,
  CredField,
  Note,
  ProviderNeeds,
  Spot,
} from "@folio/connectors-basic";
import { Effect } from "effect";
import { z } from "zod";
import { asConnector, bestEffortVerdict } from "../../upstream";
import { EARN_CATEGORIES, PROVIDER_ID } from "./constants";
import {
  bucketFailureNote,
  buildPriceHint,
  parseEarn,
  parseFunding,
  parseUnified,
  perpFallbackNote,
} from "./parse";

export const bybitAccountCreds = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

// Optional proxy base, injected from env like the other CEX overrides.
const BYBIT_BASE_KEY = "BYBIT_API_BASE";
const baseFrom = (creds: Record<string, unknown>): string => {
  const v = creds[BYBIT_BASE_KEY];
  return typeof v === "string" && v.trim() ? v.trim() : BYBIT_API_BASE;
};

// Names go into the failure note, so they live with the fetch.
interface Bucket {
  readonly name: string;
  readonly rows: (
    client: BybitClientApi,
    creds: BybitCreds,
  ) => Effect.Effect<unknown, ConnectorError, ProviderNeeds>;
}

const UNIFIED: Bucket = {
  name: "Unified",
  rows: (c, creds) => asConnector(c.walletBalance(creds)),
};
const FUNDING: Bucket = {
  name: "Funding",
  rows: (c, creds) => asConnector(c.fundingBalances(creds)),
};
const EARN: readonly Bucket[] = EARN_CATEGORIES.map((e) => ({
  name: `Earn (${e.label})`,
  rows: (c, creds) => asConnector(c.earnPositions(creds, e.category)),
}));
const BUCKETS: readonly Bucket[] = [UNIFIED, FUNDING, ...EARN];

const withClient = <A, E>(
  creds: Record<string, unknown>,
  use: (client: BybitClientApi) => Effect.Effect<A, E, ProviderNeeds>,
): Effect.Effect<A, E, ProviderNeeds> => use(makeBybitClient({ apiBase: baseFrom(creds) }));

export const bybitProvider: BalanceProvider<Spot, typeof bybitAccountCreds> = {
  id: PROVIDER_ID,
  label: "Bybit",
  // Not real credentials: an env-injected base override. May embed a proxy key: never log it.
  creds: [
    {
      key: BYBIT_BASE_KEY,
      type: "public",
      label: "API base URL",
      validator: z.string().trim().url(),
    },
  ],

  fetchBalances: (ctx) =>
    withClient(ctx.creds, (client) =>
      Effect.gen(function* () {
        const creds = ctx.account.creds;

        // Business errors (HTTP 200 + retCode ≠ 0) are already failures from the client.
        const outcomes = yield* Effect.all(
          BUCKETS.map((bucket) =>
            Effect.either(bucket.rows(client, creds)).pipe(
              Effect.map((result) => ({ bucket, result })),
            ),
          ),
          { concurrency: "unbounded" },
        );

        const failed = yield* bestEffortVerdict(outcomes);

        const bodyOf = <T>(bucket: Bucket): T | undefined => {
          const hit = outcomes.find((o) => o.bucket === bucket);
          return hit?.result._tag === "Right" ? (hit.result.right as T) : undefined;
        };

        const list = bodyOf<{
          result?: { list?: { coin?: BybitCoin[]; totalPerpUPL?: string }[] };
        }>(UNIFIED)?.result?.list?.[0];
        const coins = list?.coin ?? [];
        // Unified-account prices value funding/earn rows; if unified failed the hint is empty and
        // those rows wait for the oracle.
        const hint = buildPriceHint(coins);

        const balances: Spot[] = [
          ...parseUnified(coins),
          ...parseFunding(
            bodyOf<{ result?: { balance?: never[] } }>(FUNDING)?.result?.balance ?? [],
            hint,
          ),
          ...EARN.flatMap((bucket, i) =>
            parseEarn(
              bodyOf<{ result?: { list?: never[] } }>(bucket)?.result?.list ?? [],
              EARN_CATEGORIES[i].label,
              hint,
            ),
          ),
        ];

        const notes: Note[] = [];
        if (failed.length) {
          notes.push(
            bucketFailureNote(
              failed.map((f) => ({
                name: f.bucket.name,
                auth: f.result._tag === "Left" && f.result.left._tag === "ConnectorAuthError",
              })),
            ),
          );
        }
        const upl = Number(list?.totalPerpUPL ?? 0);
        if (list && upl !== 0) notes.push(perpFallbackNote(upl));

        return { balances, note: notes.length ? notes : undefined };
      }),
    ),

  // Bybit signals bad credentials as HTTP 200 + retCode 1000x; the client maps that to auth.
  validateAccount: (ctx) =>
    withClient(ctx.creds, (client) =>
      asConnector(client.walletBalance(ctx.account.creds)).pipe(
        Effect.as(true),
        Effect.catchTag("ConnectorAuthError", () => Effect.succeed(false)),
      ),
    ),
};
