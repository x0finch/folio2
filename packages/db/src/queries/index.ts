// db 自己定接口的那半数据访问 —— 原来是一个 1568 行的 `queries.ts`,按领域切开。
// 分法照着 `tests/` 抄:那边早就是 portfolios / tags / tab-pins / export-import / manual-* 分开测的。
//
// 这半的对外面是各领域的 per-user 服务(ADR 0037),由包出口 `src/index.ts` 逐个转出;
// 本壳只收拢类型与包内共用的东西。
// `ownership.ts` 是内件,同样不转出(`batch.ts` 已随 #394 T3 退场 —— `Database.batch` 自带空列表 no-op)。

export * from "./accounts";
export * from "./export-import";
export * from "./manual-activity";
export * from "./manual-holdings";
export * from "./portfolios";
export * from "./settings";
export * from "./snapshots";
export * from "./tab-pins";
export * from "./tags";
