import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accountKeys,
  portfolioKeys,
  preferenceKeys,
  settingsKeys,
  syncKeys,
  tagKeys,
  tokenKeys,
} from "@/lib/queries/keys";

import { invalidateFor, REFRESH_MAP } from "@/lib/queries/refresh";

// 摘要按 Portfolio 一份(ADR 0033),key 上带着它;刷新映射盖的是域前缀,与具体是哪个无关。
const PF = "pf-1";
const SNAPSHOT_AT = 1_700_000_000_000;

// 刷新映射表的钉子。**这里钉的不是「表里写了什么」**(那是把代码抄一遍),而是
// 「表里那条前缀,真的能匹配上各查询实际在用的 key 吗」—— 定向刷新唯一会静默失败的地方。
// 前缀写错一个字(`["sync"]` 写成 `["syncs"]`),运行时不报错,只表现为「同步完了面板不动」。

// 真的 QueryClient,不是 mock:匹配规则(前缀匹配、部分匹配)是 react-query 的行为,
// mock 掉就等于把要验的东西自己实现了一遍。
let queryClient: QueryClient;

// 往缓存里塞一条已成功的查询 —— invalidateQueries 的作用是把它标记为「旧」。
const seed = (queryKey: readonly unknown[]) =>
  queryClient.setQueryData([...queryKey], { seeded: true });

const isInvalidated = (queryKey: readonly unknown[]) =>
  queryClient.getQueryState([...queryKey])?.isInvalidated === true;

describe("刷新映射表", () => {
  beforeEach(() => {
    queryClient = new QueryClient();
  });

  it("sync.round 刷到账户、快照与富化,不误伤别的域", async () => {
    seed(accountKeys.list(PF));
    seed(portfolioKeys.snapshots(PF, SNAPSHOT_AT));
    seed(tokenKeys.enrichment());
    seed(settingsKeys.valuation());

    await invalidateFor(queryClient, "sync.round");

    expect(isInvalidated(accountKeys.list(PF))).toBe(true);
    expect(isInvalidated(portfolioKeys.snapshots(PF, SNAPSHOT_AT))).toBe(true);
    expect(isInvalidated(tokenKeys.enrichment())).toBe(true);
    expect(isInvalidated(settingsKeys.valuation())).toBe(false);
  });

  it("sync.round 盖住不同组合的快照键", async () => {
    const def = portfolioKeys.snapshots("pf-default", SNAPSHOT_AT);
    const other = portfolioKeys.snapshots("pf-other", SNAPSHOT_AT);
    for (const k of [def, other]) seed(k);

    await invalidateFor(queryClient, "sync.round");

    expect([isInvalidated(def), isInvalidated(other)]).toEqual([true, true]);
  });

  it("account.write 刷账户域与同步域,但不刷快照", async () => {
    seed(accountKeys.list("pf-1"));
    seed(accountKeys.manualDetail("a1"));
    seed(syncKeys.round("pf-1"));
    seed(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT));
    seed(portfolioKeys.fiatRefs("pf-1"));
    seed(tokenKeys.enrichment());

    await invalidateFor(queryClient, "account.write");

    expect(
      [accountKeys.list("pf-1"), accountKeys.manualDetail("a1"), syncKeys.round("pf-1")].map(
        isInvalidated,
      ),
    ).toEqual([true, true, true]);
    expect(isInvalidated(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT))).toBe(false);
    expect(isInvalidated(portfolioKeys.fiatRefs("pf-1"))).toBe(true);
    expect(isInvalidated(tokenKeys.enrichment())).toBe(true);
  });

  it("account.write 刷 dataStats,但不碰估值口径与 provider key", async () => {
    seed(settingsKeys.dataStats());
    seed(settingsKeys.valuation());
    seed(settingsKeys.providerKeys());

    await invalidateFor(queryClient, "account.write");

    expect(isInvalidated(settingsKeys.dataStats())).toBe(true);
    expect(isInvalidated(settingsKeys.valuation())).toBe(false);
    expect(isInvalidated(settingsKeys.providerKeys())).toBe(false);
  });

  it("account.archive 额外刷快照与 tab 条", async () => {
    seed(accountKeys.list("pf-1"));
    seed(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT));
    seed(portfolioKeys.tabPins("pf-1"));

    await invalidateFor(queryClient, "account.archive");

    expect(isInvalidated(accountKeys.list("pf-1"))).toBe(true);
    expect(isInvalidated(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT))).toBe(true);
    expect(isInvalidated(portfolioKeys.tabPins("pf-1"))).toBe(true);
  });

  it("tag.write 只刷标签域,不碰快照键", async () => {
    seed(tagKeys.list("pf-1"));
    seed(tagKeys.accountLinks("pf-1"));
    seed(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT));

    await invalidateFor(queryClient, "tag.write");

    expect([tagKeys.list("pf-1"), tagKeys.accountLinks("pf-1")].map(isInvalidated)).toEqual([
      true,
      true,
    ]);
    expect(isInvalidated(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT))).toBe(false);
  });

  it("portfolio.write 连标签域与账户域一起刷", async () => {
    seed(tagKeys.list("pf-1"));
    seed(tagKeys.accountLinks("pf-1"));
    seed(accountKeys.list("pf-1"));

    await invalidateFor(queryClient, "portfolio.write");

    expect(
      [tagKeys.list("pf-1"), tagKeys.accountLinks("pf-1"), accountKeys.list("pf-1")].map(
        isInvalidated,
      ),
    ).toEqual([true, true, true]);
  });

  it("portfolio.write 刷整个组合域(清单、tab 条、走势一起)", async () => {
    const keys = [
      portfolioKeys.list(),
      portfolioKeys.tabPins("pf-1"),
      portfolioKeys.history("pf-1", "30d"),
      portfolioKeys.snapshots("pf-1", SNAPSHOT_AT),
    ];
    for (const k of keys) seed(k);

    await invalidateFor(queryClient, "portfolio.write");

    expect(keys.map(isInvalidated)).toEqual([true, true, true, true]);
  });

  it("portfolio.pin.write 只刷 tab 条,不碰快照", async () => {
    seed(portfolioKeys.tabPins("pf-1"));
    seed(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT));

    await invalidateFor(queryClient, "portfolio.pin.write");

    expect(isInvalidated(portfolioKeys.tabPins("pf-1"))).toBe(true);
    expect(isInvalidated(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT))).toBe(false);
  });

  it("preference.locale 连法币选项一起刷,但不碰快照", async () => {
    seed(preferenceKeys.locale());
    seed(tokenKeys.fiatOptions());
    seed(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT));

    await invalidateFor(queryClient, "preference.locale");

    expect([preferenceKeys.locale(), tokenKeys.fiatOptions()].map(isInvalidated)).toEqual([
      true,
      true,
    ]);
    expect(isInvalidated(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT))).toBe(false);
  });

  it("preference.currency 只刷币种偏好", async () => {
    seed(preferenceKeys.currency());
    seed(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT));

    await invalidateFor(queryClient, "preference.currency");

    expect(isInvalidated(preferenceKeys.currency())).toBe(true);
    expect(isInvalidated(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT))).toBe(false);
  });

  it("settings.valuation 只刷估值口径键", async () => {
    seed(settingsKeys.valuation());
    seed(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT));
    seed(tokenKeys.enrichment());
    seed(syncKeys.round(PF));

    await invalidateFor(queryClient, "settings.valuation");

    expect(isInvalidated(settingsKeys.valuation())).toBe(true);
    expect(
      [
        portfolioKeys.snapshots("pf-1", SNAPSHOT_AT),
        tokenKeys.enrichment(),
        syncKeys.round(PF),
      ].map(isInvalidated),
    ).toEqual([false, false, false]);
  });

  it("settings.data 刷全部相关域", async () => {
    const keys = [
      settingsKeys.dataStats(),
      syncKeys.round(PF),
      portfolioKeys.snapshots("pf-1", SNAPSHOT_AT),
      accountKeys.list("pf-1"),
      tagKeys.list("pf-1"),
      tokenKeys.enrichment(),
    ];
    for (const k of keys) seed(k);

    await invalidateFor(queryClient, "settings.data");

    expect(keys.map(isInvalidated)).toEqual([true, true, true, true, true, true]);
  });

  it("prices.refreshed 只刷富化字典", async () => {
    seed(tokenKeys.enrichment());
    seed(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT));
    seed(syncKeys.round(PF));
    seed(settingsKeys.valuation());

    await invalidateFor(queryClient, "prices.refreshed");

    expect(isInvalidated(tokenKeys.enrichment())).toBe(true);
    expect(
      [
        portfolioKeys.snapshots("pf-1", SNAPSHOT_AT),
        syncKeys.round(PF),
        settingsKeys.valuation(),
      ].map(isInvalidated),
    ).toEqual([false, false, false]);
  });

  it("表里每条前缀都落在已知的域前缀上", () => {
    const domains: readonly (readonly string[])[] = [
      syncKeys.all,
      portfolioKeys.all,
      accountKeys.all,
      tagKeys.all,
      settingsKeys.all,
      preferenceKeys.all,
      tokenKeys.all,
    ];
    for (const [event, prefixes] of Object.entries(REFRESH_MAP)) {
      expect(prefixes.length, `${event} 至少要刷一个前缀`).toBeGreaterThan(0);
      for (const prefix of prefixes) {
        const matched = domains.some((d) => d.every((seg, i) => prefix[i] === seg));
        expect(matched, `${event} 的前缀 ${JSON.stringify(prefix)} 不属于任何已知域`).toBe(true);
      }
    }
  });
});
