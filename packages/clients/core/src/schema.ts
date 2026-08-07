import { Schema } from "effect";

// 上游的「这个字段可能没有」有**两种写法**,而同一个字段两种都见过:键干脆不出现,或者键在、值是
// `null`。TS 的 `field?: X` 只表达了前一种,而运行时两种都会到 —— 校验一上来,漏掉后一种就是
// 「上游没变、我们自己炸了」。
//
// 所以这个别名:**编码侧收 `X | null | undefined`,解码出来是 `X | undefined`**,`null` 归一成
// 「没有」。类型面因此与迁移前的 `field?: X` 一字不差,适配层不用跟着改。
//
// 例外是**「没有」和「是空」不是一回事**的字段(hyperliquid 的 `liquidationPx`:没强平价 vs
// 没给这个字段)。那种别用这个,写 `Schema.optional(Schema.NullOr(X))`,把 `null` 留在类型里。
export const maybe = <A, I, R>(schema: Schema.Schema<A, I, R>) =>
  Schema.optionalWith(schema, { nullable: true });
