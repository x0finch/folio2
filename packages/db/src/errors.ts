import { Data } from "effect";

// 这一层的**类型化失败**。「失败」= 调用方有可能预期到、也有话可回的情况;真 bug 继续当 defect
// 炸(`Effect.die`),不进 `E` 通道 —— 那条界线是 Effect 迁移全程的判据,不是本文件的新规矩。

/**
 * 要的东西不在,或者**不是这个用户的**。
 *
 * 两种情形共用一个错误不是偷懒,是**刻意的**:「别人的账户」与「不存在的账户」对调用方必须
 * 长得一模一样 —— 分开报等于给出一个探测别人 id 是否存在的接口(原则 #5 那条红线的同一个道理)。
 * 归属断言(`domains/ownership.ts`)因此一律 fail 它。
 *
 * 以前这里是 `throw new Error("account not found: …")`,落在 `client.query` 的 promise 里 ——
 * 于是「越权」和「代码写错了」在类型上没有区别,两者都是 defect,handler 想区别对待也无从下手。
 * 现在它在 `E` 通道里,人话消息由 `runEffect` 一处映射(#504 T6)。
 */
export class NotFound extends Data.TaggedError("db/NotFound")<{
  /** 找的是什么 —— `account` / `portfolio` / `tag` / `token` / `tab pin` / `manual activity`。 */
  readonly entity: string;
  /** 找的那一个的 id。**只有 id**,不带任何行内容(别把「不存在」变成一次数据泄露)。 */
  readonly id: string;
}> {
  // `Data.TaggedError` 不会自己拼 `message`,而它 extends `Error` —— 不给的话日志里只剩一个
  // 空消息加一坨 Cause(`oracle.ts` 的 `toError` 早就踩过同一个坑)。这一句让它在任何
  // `Cause.pretty` / `runPromise` 拒绝里都自带人话。
  override get message(): string {
    return `${this.entity} not found: ${this.id}`;
  }
}
