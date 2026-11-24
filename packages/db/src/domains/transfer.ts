import { and, asc, eq, isNull, or } from "drizzle-orm";
import { Effect } from "effect";
import type { DbClient } from "../client";
import type { NotFound } from "../errors";
import {
  accounts,
  manualActivity,
  portfolioAccounts,
  snapshots,
  tokenRefs,
  tokens,
} from "../schema";
import type { CreateAccountInput } from "./accounts";
import { type ManualActivityInput, makeManualStore } from "./manual";
import { assertAccountOwned, assertTokenOwned } from "./ownership";
import { ensureDefault } from "./portfolios";
import { makeSnapshotStore, type WriteSnapshotInput } from "./snapshots";

// Export / import of a user's data; tokens travel with their refs.

// Price fields and TTLs aren't exported: market data can be refetched.
export interface ExportToken {
  id: string;
  symbol: string;
  name: string;
  logo: string | null;
  providerLogo: string | null;
  marketCapRank: number | null;
  refs: { namer: string; localName: string }[];
}

export interface ImportTokenInput {
  symbol: string;
  name: string;
  logo?: string | null;
  providerLogo?: string | null;
  marketCapRank?: number | null;
}

// Merge-style import: find-or-create by natural content keys, so re-importing or merging files is
// idempotent. Always mints new ids (ids are global PKs; dedup uses per-user natural keys).
export const makeTransferStore = (client: DbClient["Service"], userId: string) => {
  const snapshotStore = makeSnapshotStore(client, userId);
  const manualStore = makeManualStore(client, userId);

  return {
    listTokensForExport: (): Effect.Effect<ExportToken[]> =>
      Effect.gen(function* () {
        const rows = yield* client.query((db) =>
          db
            .select({
              id: tokens.id,
              symbol: tokens.symbol,
              name: tokens.name,
              logo: tokens.logo,
              providerLogo: tokens.providerLogo,
              marketCapRank: tokens.marketCapRank,
            })
            .from(tokens)
            .where(eq(tokens.userId, userId))
            .orderBy(asc(tokens.id)),
        );
        if (rows.length === 0) return [];
        const refRows = yield* client.query((db) =>
          db
            .select({
              tokenId: tokenRefs.tokenId,
              namer: tokenRefs.namer,
              localName: tokenRefs.localName,
            })
            .from(tokenRefs)
            .where(eq(tokenRefs.userId, userId)),
        );
        const byToken = new Map<string, { namer: string; localName: string }[]>();
        for (const r of refRows) {
          const ref = { namer: r.namer, localName: r.localName };
          const arr = byToken.get(r.tokenId);
          if (arr) arr.push(ref);
          else byToken.set(r.tokenId, [ref]);
        }
        return rows.map((t) => ({ ...t, refs: byToken.get(t.id) ?? [] }));
      }),

    /**
     * Find-or-create: if any ref already maps to a local token, reuse it and attach the missing refs;
     * otherwise insert a new token with all refs. Returns the final token id for old->new mapping.
     * Known limit: refs hitting different local tokens get merged into the first hit. Import only
     * targets an empty database, so that path doesn't reach it.
     */
    // Untargeted onConflict: a clash on either the PK or the (user, token, namer) index is skipped.
    importToken: (
      t: ImportTokenInput,
      refs: readonly { namer: string; localName: string }[],
      now: () => number = Date.now,
    ): Effect.Effect<string> =>
      Effect.gen(function* () {
        if (refs.length > 0) {
          const hit = yield* client.query((db) =>
            db
              .select({ tokenId: tokenRefs.tokenId })
              .from(tokenRefs)
              .where(
                and(
                  eq(tokenRefs.userId, userId),
                  or(
                    ...refs.map((r) =>
                      and(eq(tokenRefs.namer, r.namer), eq(tokenRefs.localName, r.localName)),
                    ),
                  ),
                ),
              )
              .limit(1),
          );
          const target = hit[0]?.tokenId;
          if (target) {
            // Reusing: attach the refs it lacks; clashes are skipped.
            yield* client.batch((db) =>
              refs.map((r) =>
                db
                  .insert(tokenRefs)
                  .values({ userId, namer: r.namer, localName: r.localName, tokenId: target })
                  .onConflictDoNothing(),
              ),
            );
            return target;
          }
        }

        const id = crypto.randomUUID();
        yield* client.batch((db) => [
          db.insert(tokens).values({
            id,
            userId,
            symbol: t.symbol,
            name: t.name,
            logo: t.logo ?? null,
            providerLogo: t.providerLogo ?? null,
            marketCapRank: t.marketCapRank ?? null,
            infoExpiresAt: now(), // stale on insert, so the next refresh fills name/logo/price
          }),
          ...refs.map((r) =>
            db
              .insert(tokenRefs)
              .values({ userId, namer: r.namer, localName: r.localName, tokenId: id })
              .onConflictDoNothing(),
          ),
        ]);
        return id;
      }),

    /** Natural key: (connectorId, platform, label, creds). Archive state is mutable, not part of it. */
    importAccount: (
      input: CreateAccountInput & { archivedAt?: number | null },
    ): Effect.Effect<{ id: string; created: boolean }> =>
      Effect.gen(function* () {
        const platform = input.platform ?? null;
        const creds = input.creds ?? null;
        const existing = yield* client.query((db) =>
          db
            .select({ id: accounts.id, archivedAt: accounts.archivedAt })
            .from(accounts)
            .where(
              and(
                eq(accounts.userId, userId),
                eq(accounts.connectorId, input.connectorId),
                platform === null ? isNull(accounts.platform) : eq(accounts.platform, platform),
                eq(accounts.label, input.label),
                creds === null ? isNull(accounts.creds) : eq(accounts.creds, creds),
              ),
            )
            .limit(1),
        );
        const hit = existing[0];
        if (hit) {
          if (input.archivedAt != null && hit.archivedAt == null) {
            yield* client.query((db) =>
              db
                .update(accounts)
                .set({ archivedAt: input.archivedAt })
                .where(and(eq(accounts.id, hit.id), eq(accounts.userId, userId))),
            );
          }
          return { id: hit.id, created: false };
        }
        // Account + default-portfolio membership in one batch (one membership per account).
        const pf = yield* ensureDefault(client, userId);
        const id = crypto.randomUUID();
        yield* client.batch((db) => [
          db.insert(accounts).values({
            id,
            userId,
            connectorId: input.connectorId,
            platform,
            label: input.label,
            creds,
            createdAt: Date.now(),
            archivedAt: input.archivedAt ?? null,
          }),
          db.insert(portfolioAccounts).values({ portfolioId: pf.id, accountId: id }),
        ]);
        return { id, created: true };
      }),

    /** Natural key: (accountId, takenAt); an existing snapshot is skipped whole. */
    importSnapshot: (
      accountId: string,
      input: WriteSnapshotInput,
    ): Effect.Effect<{ created: boolean }, NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        const existing = yield* client.query((db) =>
          db
            .select({ id: snapshots.id })
            .from(snapshots)
            .where(and(eq(snapshots.accountId, accountId), eq(snapshots.takenAt, input.takenAt)))
            .limit(1),
        );
        if (existing[0]) return { created: false };
        yield* snapshotStore.write(accountId, input);
        return { created: true };
      }),

    // Natural key is the whole row including createdAt: same-occurredAt rows that differ only in
    // createdAt are distinct events, and dropping it would merge them and lose amounts.
    importManualActivity: (
      accountId: string,
      tokenId: string,
      input: ManualActivityInput,
    ): Effect.Effect<{ created: boolean }, NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        yield* assertTokenOwned(client, userId, tokenId);
        const price = input.price ?? null;
        const fee = input.fee ?? null;
        const memo = input.memo ?? null;
        const existing = yield* client.query((db) =>
          db
            .select({ id: manualActivity.id })
            .from(manualActivity)
            .where(
              and(
                eq(manualActivity.accountId, accountId),
                eq(manualActivity.tokenId, tokenId),
                eq(manualActivity.kind, input.kind),
                eq(manualActivity.amount, input.amount),
                price === null ? isNull(manualActivity.price) : eq(manualActivity.price, price),
                fee === null ? isNull(manualActivity.fee) : eq(manualActivity.fee, fee),
                eq(manualActivity.occurredAt, input.occurredAt),
                memo === null ? isNull(manualActivity.memo) : eq(manualActivity.memo, memo),
                input.createdAt != null ? eq(manualActivity.createdAt, input.createdAt) : undefined,
              ),
            )
            .limit(1),
        );
        if (existing[0]) return { created: false };
        yield* manualStore.recordActivity(accountId, tokenId, input);
        return { created: true };
      }),
  };
};
