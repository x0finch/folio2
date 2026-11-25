import type { ConnectorId } from "@folio/connectors";
import { Database, InvalidInput } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import {
  accountsInView,
  MAX_PINS_PER_PORTFOLIO,
  type PinTargetRef,
  pinsInView,
  type TabPinScope,
} from "@/lib/core/accounts-in-view";
import { serverFn } from "@/lib/server/server-fn";

// Shared with update-target; consistency with `TabPinScope` is checked where the handler is wired.
export const PinTargetInput = z.object({
  kind: z.enum(["connector", "tag", "account"]),
  connectorId: z.string().optional(),
  tagId: z.string().optional(),
  accountId: z.string().optional(),
});

/**
 * Enforces the per-portfolio pin cap in every portfolio the pin would appear in, derived from its
 * target rather than a caller-supplied portfolio (which could be gamed). Connector pins appear in
 * several portfolios. `excludePinId` lets update-target ignore the pin's current placement.
 */
export const assertPinCap = (candidate: PinTargetRef, excludePinId?: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [pins, allAccounts, memberships, tags, portfolios, defaultPf] = yield* Effect.all(
      [
        db.tabPins.list(),
        db.accounts.list(),
        db.portfolios.listMemberships(),
        db.tags.list(),
        db.portfolios.list(),
        db.portfolios.ensureDefault(),
      ],
      { concurrency: 6 },
    );
    const existing = pins.filter((p) => p.id !== excludePinId);
    for (const pf of portfolios) {
      const view = {
        accounts: accountsInView(allAccounts, memberships, pf.id, defaultPf.id),
        tagIds: new Set(tags.filter((t) => t.portfolioId === pf.id).map((t) => t.id)),
      };
      if (pinsInView([{ ...candidate, id: "candidate" }], view).length === 0) continue;
      // Typed failure: a stale page can still send this, and "this portfolio is full" is for users.
      if (pinsInView(existing, view).length >= MAX_PINS_PER_PORTFOLIO) {
        return yield* Effect.fail(
          new InvalidInput({
            what: "tab pin",
            why: `cannot pin more than ${MAX_PINS_PER_PORTFOLIO} custom tabs per portfolio`,
          }),
        );
      }
    }
  });

export const handleCreateTabPin = serverFn("createTabPin")(function* (
  data: NonNullable<TabPinScope>,
) {
  const db = yield* Database;
  yield* assertPinCap(data);
  const pin = yield* db.tabPins.create({
    kind: data.kind,
    connectorId: data.connectorId as ConnectorId | undefined,
    tagId: data.tagId,
    accountId: data.accountId,
  });
  return pin;
});
