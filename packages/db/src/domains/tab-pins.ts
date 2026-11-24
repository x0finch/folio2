import type { ConnectorId } from "@folio/connectors";
import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { DbClient } from "../client";
import { InvalidInput, NotFound } from "../errors";
import { tabPins } from "../schema";
import type { TabPin } from "../schema/types";
import { assertAccountOwned, assertTagOwned } from "./ownership";

// Custom tabs: pin a tag / account / connector as a navigation entry.

const assertTabPinOwned = (
  client: DbClient,
  userId: string,
  pinId: string,
): Effect.Effect<void, NotFound> =>
  client
    .query((db) =>
      db
        .select({ id: tabPins.id })
        .from(tabPins)
        .where(and(eq(tabPins.id, pinId), eq(tabPins.userId, userId))),
    )
    .pipe(
      Effect.flatMap((rows) =>
        rows[0] ? Effect.void : Effect.fail(new NotFound({ entity: "tab pin", id: pinId })),
      ),
    );

export interface TabPinInput {
  kind: "connector" | "tag" | "account";
  tagId?: string | null;
  accountId?: string | null;
  connectorId?: ConnectorId | null;
  sortOrder?: number;
}

// Connector pins have no FK, so their existence isn't checked. A missing target id is
// `InvalidInput`, not a defect: the input schema makes all three optional, so it can get through.
const resolvePinTarget = (
  client: DbClient,
  userId: string,
  input: Pick<TabPinInput, "kind" | "tagId" | "accountId" | "connectorId">,
): Effect.Effect<
  { tagId: string | null; accountId: string | null; connectorId: ConnectorId | null },
  NotFound | InvalidInput
> =>
  Effect.gen(function* () {
    if (input.kind === "tag") {
      if (!input.tagId) return yield* missingTarget("tag pin", "tagId");
      yield* assertTagOwned(client, userId, input.tagId);
      return { tagId: input.tagId, accountId: null, connectorId: null };
    }
    if (input.kind === "account") {
      if (!input.accountId) return yield* missingTarget("account pin", "accountId");
      yield* assertAccountOwned(client, userId, input.accountId);
      return { tagId: null, accountId: input.accountId, connectorId: null };
    }
    if (!input.connectorId) return yield* missingTarget("connector pin", "connectorId");
    return { tagId: null, accountId: null, connectorId: input.connectorId };
  });

const missingTarget = (what: string, field: string): Effect.Effect<never, InvalidInput> =>
  Effect.fail(new InvalidInput({ what, why: `requires ${field}` }));

export const makeTabPinStore = (client: DbClient, userId: string) => {
  return {
    /**
     * The per-portfolio pin limit isn't enforced here: which portfolio a pin belongs to is derived
     * from tag/account membership, so the app layer checks it.
     */
    create: (input: TabPinInput): Effect.Effect<TabPin, NotFound | InvalidInput> =>
      Effect.gen(function* () {
        // Appends at the end; unrelated to the limit.
        const existing = yield* client.query((db) =>
          db.select({ id: tabPins.id }).from(tabPins).where(eq(tabPins.userId, userId)),
        );
        const target = yield* resolvePinTarget(client, userId, input);
        const row = {
          id: crypto.randomUUID(),
          userId,
          kind: input.kind,
          tagId: target.tagId,
          accountId: target.accountId,
          connectorId: target.connectorId,
          sortOrder: input.sortOrder ?? existing.length,
        };
        yield* client.query((db) => db.insert(tabPins).values(row));
        return row;
      }),

    /** Stable order: sortOrder, then id. */
    list: (): Effect.Effect<TabPin[]> =>
      client.query((db) =>
        db
          .select()
          .from(tabPins)
          .where(eq(tabPins.userId, userId))
          .orderBy(asc(tabPins.sortOrder), asc(tabPins.id)),
      ),

    updateTarget: (
      pinId: string,
      patch: Pick<TabPinInput, "kind" | "tagId" | "accountId" | "connectorId">,
    ): Effect.Effect<void, NotFound | InvalidInput> =>
      Effect.gen(function* () {
        yield* assertTabPinOwned(client, userId, pinId);
        const target = yield* resolvePinTarget(client, userId, patch);
        yield* client.query((db) =>
          db
            .update(tabPins)
            .set({
              kind: patch.kind,
              tagId: target.tagId,
              accountId: target.accountId,
              connectorId: target.connectorId,
            })
            .where(and(eq(tabPins.id, pinId), eq(tabPins.userId, userId))),
        );
      }),

    /** Pins missing from the list keep their order; an empty list is a no-op. */
    reorder: (orderedIds: string[]): Effect.Effect<void> =>
      client.batch((db) =>
        orderedIds.map((id, i) =>
          db
            .update(tabPins)
            .set({ sortOrder: i })
            .where(and(eq(tabPins.id, id), eq(tabPins.userId, userId))),
        ),
      ),

    /**
     * Cleanup when archiving an account, so unarchiving doesn't bring back an over-limit tab.
     * Deleting an account doesn't need it: the FK cascade handles that.
     */
    removeByAccount: (accountId: string): Effect.Effect<void> =>
      Effect.asVoid(
        client.query((db) =>
          db
            .delete(tabPins)
            .where(and(eq(tabPins.accountId, accountId), eq(tabPins.userId, userId))),
        ),
      ),

    /** Only deletes the pointer, no data, so callers need no confirmation. */
    remove: (pinId: string): Effect.Effect<void> =>
      Effect.asVoid(
        client.query((db) =>
          db.delete(tabPins).where(and(eq(tabPins.id, pinId), eq(tabPins.userId, userId))),
        ),
      ),
  };
};
