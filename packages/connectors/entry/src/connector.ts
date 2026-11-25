import type { Balance, CredField } from "@folio/connectors-basic";
import type { BalanceUpstream } from "@folio/upstream-basic";
import type { z } from "zod";

// A connector is one kind of account we support (not a platform, which is a chain or venue).

// authoritative (default): the provider's USD value is trusted and enrichment doesn't reprice it.
// mark-to-market: no trusted price, always valued at the market source price (e.g. manual).
export type ConnectorValuation = "authoritative" | "mark-to-market";

// Type-erased manifest for the heterogeneous registry; generics only exist at `defineConnector`.
// Whether stored non-public creds still belong to the account after its public ones change from
// `previous` to `next` (both plaintext). Absent: they always do.
type KeepsSecrets = (
  previous: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
) => boolean;

// Non-public creds that become required by the account's public ones (custom: a keyed config).
type NeededCreds = (publicCreds: Readonly<Record<string, string>>) => readonly string[];

export interface ConnectorManifest {
  readonly id: string;
  readonly label: string;
  readonly logo: string;
  readonly account: {
    readonly creds: readonly CredField[];
    readonly keepsSecrets?: KeepsSecrets;
    readonly needs?: NeededCreds;
  };
  readonly balance: {
    readonly schema: z.ZodType<Balance>;
    readonly providers: readonly BalanceUpstream<Balance>[];
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
  account: { creds: AC; keepsSecrets?: KeepsSecrets; needs?: NeededCreds };
  balance: { schema: S; providers: BalanceUpstream<z.infer<S>, AC>[] };
  valuation?: ConnectorValuation;
}): ConnectorManifest & { readonly id: Id } {
  // Keeps the literal id so the registry can derive a ConnectorId union.
  return m as unknown as ConnectorManifest & { readonly id: Id };
}
