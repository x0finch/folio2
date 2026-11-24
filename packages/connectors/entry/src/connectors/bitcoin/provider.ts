import { BitcoinDeriveError, blockbookXpubParam, SCRIPT_TYPES } from "@folio/bitcoin-derive";
import { type BlockbookClientApi, make as makeBlockbookClient } from "@folio/blockbook-client";
import type { UpstreamError } from "@folio/client-core";
import {
  type BalanceProvider,
  ConnectorAuthError,
  type ConnectorError,
  ConnectorFailure,
  type CredField,
  type Note,
  type ProviderNeeds,
  type Spot,
} from "@folio/connectors-basic";
import { Effect } from "effect";
import { z } from "zod";
import { fromUpstreamError } from "../../upstream";
import { BTC_ADDRESS_RE, EXT_PUBKEY_FULL_RE } from "./constants";
import {
  buildBtcNote,
  buildXpubMeta,
  effectiveScript,
  isExtendedPubkey,
  toBtcBalances,
  toSats,
} from "./parse";

export const bitcoinAccountCreds = [
  {
    key: "addressOrXpub",
    type: "public",
    label: "Bitcoin address or xpub",
    desc: "address (1…/3…/bc1…) or xpub/ypub/zpub",
    validator: z.string().refine((v) => BTC_ADDRESS_RE.test(v) || EXT_PUBKEY_FULL_RE.test(v), {
      message: "expected a BTC address or extended public key",
    }),
  },
  {
    key: "scriptType",
    type: "public",
    label: "Address type",
    validator: z.enum(SCRIPT_TYPES).optional(),
  },
] as const satisfies readonly CredField[];

// Unset in production (rotates over built-in public nodes); set to pin one node, e.g. a self-hosted
// one or a local fake upstream for perf tests. Injected from env like the CEX base overrides.
const BLOCKBOOK_BASE_KEY = "BLOCKBOOK_API_BASE";
const providerCreds = [
  {
    key: BLOCKBOOK_BASE_KEY,
    type: "public",
    label: "Blockbook API base URL",
    validator: z.string().trim().url(),
  },
] as const satisfies readonly CredField[];

// No rate gate here (retry = next public node), so construction is pure; build the default once.
const defaultClient: BlockbookClientApi = makeBlockbookClient();

const clientFor = (creds: Record<string, unknown>): BlockbookClientApi => {
  const v = creds[BLOCKBOOK_BASE_KEY];
  return typeof v === "string" && v.trim()
    ? makeBlockbookClient({ bases: [v.trim()] })
    : defaultClient;
};

// Unlike `asConnector`: a server 4xx (e.g. an invalid xpub) is permanent, since every node will
// return the same thing, so don't retry it.
const asBitcoin = <A, R>(
  effect: Effect.Effect<A, UpstreamError, R>,
): Effect.Effect<A, ConnectorError, R> =>
  Effect.mapError(effect, (error) =>
    error._tag === "UpstreamUnavailableError" &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500
      ? new ConnectorFailure({ message: error.message, cause: error })
      : fromUpstreamError(error),
  );

// An unparseable extended key is a local credentials failure, not an upstream one.
const derivationIsCredentials = <A, R>(
  effect: Effect.Effect<A, ConnectorError, R>,
): Effect.Effect<A, ConnectorError, R> =>
  Effect.catchDefect(effect, (defect) =>
    defect instanceof BitcoinDeriveError
      ? Effect.fail(new ConnectorAuthError({ message: defect.message, cause: defect }))
      : Effect.die(defect),
  );

// details=tokenBalances&tokens=used: totals plus per-address detail in one call.
const fromXpub = (
  client: BlockbookClientApi,
  ext: string,
  scriptType: string | undefined,
): Effect.Effect<{ balances: Spot[]; note: Note[] }, ConnectorError, ProviderNeeds> =>
  Effect.suspend(() => {
    const script = effectiveScript(ext, scriptType);
    return asBitcoin(client.xpub(blockbookXpubParam(ext, script))).pipe(
      Effect.map((res) => {
        const pendingSats = toSats(res.unconfirmedBalance);
        const { addresses, receive } = buildXpubMeta(ext, script, res.tokens ?? []);
        return {
          balances: toBtcBalances(toSats(res.balance), pendingSats),
          note: buildBtcNote(pendingSats, { addresses, receive }),
        };
      }),
    );
  });

const fromAddress = (
  client: BlockbookClientApi,
  address: string,
): Effect.Effect<{ balances: Spot[]; note: Note[] }, ConnectorError, ProviderNeeds> =>
  asBitcoin(client.address(address)).pipe(
    Effect.map((res) => {
      const pendingSats = toSats(res.unconfirmedBalance);
      return {
        balances: toBtcBalances(toSats(res.balance), pendingSats),
        note: buildBtcNote(pendingSats),
      };
    }),
  );

export const blockbookProvider: BalanceProvider<
  Spot,
  typeof bitcoinAccountCreds,
  typeof providerCreds
> = {
  id: "blockbook",
  label: "Blockbook",
  creds: providerCreds,

  fetchBalances: (ctx) => {
    const id = ctx.account.creds.addressOrXpub;
    const client = clientFor(ctx.creds);
    return derivationIsCredentials(
      isExtendedPubkey(id)
        ? fromXpub(client, id, ctx.account.creds.scriptType)
        : fromAddress(client, id),
    );
  },

  // `xpubSummary` (details=basic): the probe doesn't need per-address detail.
  validateAccount: (ctx) => {
    const id = ctx.account.creds.addressOrXpub;
    const client = clientFor(ctx.creds);
    const probe = Effect.suspend(() =>
      isExtendedPubkey(id)
        ? asBitcoin(
            client.xpubSummary(
              blockbookXpubParam(id, effectiveScript(id, ctx.account.creds.scriptType)),
            ),
          )
        : asBitcoin(client.address(id)),
    );
    return derivationIsCredentials(probe).pipe(
      Effect.as(true),
      Effect.catchTag("ConnectorAuthError", () => Effect.succeed(false)),
    );
  },
};
