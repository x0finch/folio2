// db 自己定接口的那半数据访问 —— 原来是一个 1568 行的 `queries.ts`,按领域切开。
// 分法照着 `tests/` 抄:那边早就是 portfolios / tags / tab-pins / export-import / manual-* 分开测的。
//
// 这半的对外面是 `facade.ts` 的 `createDb` —— 包出口只转它,领域函数各自只被门面用,所以切分
// 是包内的事,包外看不见。**本壳不转 facade**:facade 自己要 `import * as q from "."`,转了就成环。
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
