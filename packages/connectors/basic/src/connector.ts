import type { Outbound } from "@folio/client-core";
import type { UpstreamError } from "@folio/upstream-basic";
import type { Effect } from "effect";
import type { z } from "zod";
import type { Balance } from "./balance";
import type { CredField, CredsOf } from "./creds";
import type { Note } from "./note";

// A connector is one kind of account we support (not a platform, which is a chain or venue).
// Outbound HTTP is a requirement in `R` rather than provided inside each provider, so tests can
// swap it. Type-only import: this package is bundled into the client, so never value-import
// `@folio/client-core` here.
export type ProviderNeeds = Outbound;

export interface FetchContext<AC = Record<string, unknown>, PC = Record<string, unknown>> {
  readonly account: { id: string; label: string; connectorId: string; creds: AC };
  readonly creds: PC;
}

export interface BalanceProvider<
  B extends Balance,
  AC extends readonly CredField[] = readonly CredField[],
  PC extends readonly CredField[] = readonly CredField[],
> {
  readonly id: string;
  readonly label: string;
  readonly creds: PC; // empty = works out of the box
  readonly defaultEnabled?: boolean;
  // Effect, not Promise: converting to a Promise mid-way cuts off outer timeouts, interruption
  // and TestClock.
  fetchBalances(
    ctx: FetchContext<CredsOf<AC>, CredsOf<PC>>,
  ): Effect.Effect<{ balances: B[]; note?: Note[] }, UpstreamError, ProviderNeeds>;
  // Succeeds with `false` only when the upstream rejects the credentials or they're malformed.
  // Unreachable upstream (429 / 5xx / network / bad response) goes to the error channel so callers
  // can retry; collapsing it to `false` would show a transient 429 as "bad credentials".
  validateAccount(
    ctx: FetchContext<CredsOf<AC>, CredsOf<PC>>,
  ): Effect.Effect<boolean, UpstreamError, ProviderNeeds>;
}

// authoritative (default): the provider's USD value is trusted and enrichment doesn't reprice it.
// mark-to-market: no trusted price, always valued at the market source price (e.g. manual).
export type ConnectorValuation = "authoritative" | "mark-to-market";

// Type-erased manifest for the heterogeneous registry; generics only exist at `defineConnector`.
export interface ConnectorManifest {
  readonly id: string;
  readonly label: string;
  readonly logo: string;
  readonly account: { readonly creds: readonly CredField[] };
  readonly balance: {
    readonly schema: z.ZodType<Balance>;
    readonly providers: readonly BalanceProvider<Balance>[];
  };
  readonly valuation?: ConnectorValuation; // default authoritative
}

// Exists only for inference: the schema is the source of truth (`B = z.infer<S>`; never annotate
// as `z.ZodType<B>`, a zod v4 footgun), so a provider emitting a wrong kind fails to compile.
export function defineConnector<
  S extends z.core.$ZodType<Balance>,
  const AC extends readonly CredField[],
  const Id extends string = string,
>(m: {
  id: Id;
  label: string;
  logo: string;
  account: { creds: AC };
  balance: { schema: S; providers: BalanceProvider<z.infer<S>, AC>[] };
  valuation?: ConnectorValuation;
}): ConnectorManifest & { readonly id: Id } {
  // Keeps the literal id so the registry can derive a ConnectorId union.
  return m as unknown as ConnectorManifest & { readonly id: Id };
}
