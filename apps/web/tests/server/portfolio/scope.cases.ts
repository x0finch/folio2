import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { handleListTags } from "@/lib/server/tags/list";
import { db } from "../_kit/db";
import { fakeRegistry } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";
import { call, callWithRegistry, readAccountHoldingsView } from "../_kit/run";
import { seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// Scoping happens server-side: these account-domain reads must all narrow to the current portfolio.
// One cross-cutting case because a missed endpoint renders fine while still leaking data.
describe("portfolio/scope", () => {
  const USER = "h-pf-scope";

  // Default vs another portfolio, one account each; the default one also has a tag, since tags are
  // portfolio-scoped too.
  let DEFAULT_ID = "";
  let WATCH_ID = "";
  let MINE = "";
  let WATCHED = "";

  const listed = async (portfolioId?: string) => {
    const { registry } = await fakeRegistry();
    return callWithRegistry(USER, registry, handleListAccounts({ portfolioId }));
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    const def = await db(USER).portfolios.ensureDefault();
    const watch = await db(USER).portfolios.create({ name: "Watch" });
    DEFAULT_ID = def.id;
    WATCH_ID = watch.id;
    const mine = await seedAccount(USER, "自己的", "bitcoin");
    const watched = await seedAccount(USER, "只看看", "binance");
    MINE = mine.id;
    WATCHED = watched.id;
    await db(USER).portfolios.assignAccount(MINE, DEFAULT_ID);
    await db(USER).portfolios.assignAccount(WATCHED, WATCH_ID);
    const now = Date.now();
    await seedSnapshot(USER, MINE, now, [{ tokenId: "bitcoin", amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, WATCHED, now, [{ tokenId: "ethereum", amount: 2, usdValue: 50 }]);
    const tag = await db(USER).tags.create({ portfolioId: DEFAULT_ID, name: "长期" });
    await db(USER).tags.attach(MINE, tag.id);
    await db(USER).tags.create({ portfolioId: WATCH_ID, name: "观察中" });
  });

  describe("account domain is scoped to the current portfolio", () => {
    it("account list returns only this portfolio's accounts, with membership", async () => {
      expect((await listed(WATCH_ID)).map((a) => a.label)).toEqual(["只看看"]);
      expect((await listed(WATCH_ID))[0].portfolioId).toBe(WATCH_ID);
      expect((await listed(DEFAULT_ID)).map((a) => a.label)).toEqual(["自己的"]);
    });

    it("no portfolio param = default portfolio", async () => {
      expect((await listed()).map((a) => a.label)).toEqual(["自己的"]);
    });

    it("per-account holdings (with 24h P&L) only for this portfolio", async () => {
      // P&L ships in the same per-account rows, so this covers both holdings and P&L.
      const holdings = await readAccountHoldingsView(USER, { portfolioId: WATCH_ID });
      expect(holdings.rows.map((r) => r.account.label)).toEqual(["只看看"]);
      expect(holdings.rows.map((r) => r.account.id)).toEqual([WATCHED]);
    });

    it("tag definitions and account→tag links are scoped too", async () => {
      expect(
        (await call(USER, handleListTags({ portfolioId: WATCH_ID }))).map((t) => t.name),
      ).toEqual(["观察中"]);
      // The only link is on a default-portfolio account → none for Watch.
      expect(await call(USER, handleListAccountTags({ portfolioId: WATCH_ID }))).toEqual([]);
      expect(
        (await call(USER, handleListAccountTags({ portfolioId: DEFAULT_ID }))).map(
          (l) => l.accountId,
        ),
      ).toEqual([MINE]);
    });

    it("archived accounts are still included (the accounts page has an archive section)", async () => {
      await db(USER).accounts.setArchived(WATCHED, true);

      expect((await listed(WATCH_ID)).map((a) => a.label)).toEqual(["只看看"]);
      const holdings = await readAccountHoldingsView(USER, { portfolioId: WATCH_ID });
      expect(holdings.rows.map((r) => r.account.label)).toEqual(["只看看"]);
    });

    it("unknown portfolio id (someone else's / deleted) → silently default, not empty", async () => {
      const theirs = await db(otherUser(USER)).portfolios.ensureDefault();

      expect((await listed(theirs.id)).map((a) => a.label)).toEqual(["自己的"]);
      expect((await listed("pf-does-not-exist")).map((a) => a.label)).toEqual(["自己的"]);
    });
  });
});
