// db 自己定接口的那半数据访问 —— **一域一文件**(#504 T4)。原来是一个 1568 行的 `queries.ts`,
// 先按领域切开,这一轮把目录名对齐到它装的东西:`queries/` 是「怎么取」,而这里装的是「哪个领域」。
//
// 一域一文件也把两处遗留收了:`export-import.ts` → `transfer.ts`(跟服务名 `TransferStore` 对齐),
// `manual-activity.ts` + `manual-holdings.ts` → `manual.ts`(持仓与账本是同一个领域的两面,
// 拆成两个文件是它们曾经是两个服务时的形状)。
//
// 这半的对外面是各领域的 per-user 服务(ADR 0037),由包出口 `src/index.ts` 逐个转出;
// 本壳只收拢类型与包内共用的东西。
//
// **`ownership.ts` 是内件,不转出。** 它没有跟着「一域一文件」拆到各领域去:那四个断言是**跨领域**
// 被用的(账户那道被 portfolio / tag / tab pin / 快照 / 手记五处调),拆下去会让 accounts 与
// portfolios 互相 import —— 为了少一个文件换一个循环依赖,不划算。

export * from "./accounts";
export * from "./manual";
export * from "./portfolios";
export * from "./settings";
export * from "./snapshots";
export * from "./tab-pins";
export * from "./tags";
export * from "./transfer";
