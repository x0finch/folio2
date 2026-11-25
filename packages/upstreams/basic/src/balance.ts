import type { Balance, CredField, CredsOf, Note } from "@folio/connectors-basic";
import type { Effect } from "effect";
import type { HttpClient } from "effect/http";
import type { UpstreamError } from "./errors";

// Outbound HTTP is a requirement in `R` rather than provided inside each upstream, so tests can
// swap it.
export type UpstreamNeeds = HttpClient.HttpClient;

export interface FetchContext<AC = Record<string, unknown>, PC = Record<string, unknown>> {
  readonly account: { id: string; label: string; connectorId: string; creds: AC };
  readonly creds: PC;
}

export interface BalanceUpstream<
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
  ): Effect.Effect<{ balances: B[]; note?: Note[] }, UpstreamError, UpstreamNeeds>;
  // Succeeds with `false` only when the upstream rejects the credentials or they're malformed.
  // Unreachable upstream (429 / 5xx / network / bad response) goes to the error channel so callers
  // can retry; collapsing it to `false` would show a transient 429 as "bad credentials".
  validateAccount(
    ctx: FetchContext<CredsOf<AC>, CredsOf<PC>>,
  ): Effect.Effect<boolean, UpstreamError, UpstreamNeeds>;
}
