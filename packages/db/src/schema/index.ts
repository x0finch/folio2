// 表定义的出口。**薄壳** —— 全部真定义在 app.ts / auth.ts 里。
//
// 拆成两个文件是因为它们的所有者不同:`auth.ts` 那几张表由 better-auth 的官方规格决定
// (照抄,不自作主张),`app.ts` 是本项目自己的表。行类型在 types.ts。
export * from "./app";
export * from "./auth";
