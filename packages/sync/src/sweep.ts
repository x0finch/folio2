import { Chunk, Effect, Option, Stream } from "effect";
import { syncAccount } from "./account";
import { SYNC_CONCURRENCY } from "./constants";
import type { SyncDepError } from "./errors";
import { AccountStore, type SyncServices } from "./services";
import type { AccountSyncResult, SyncResult } from "./types";

// 一个用户的一轮同步,**逐账户产出结果**。
//
// 为什么是流不是「跑完给个数组」:主页的「立即同步」要边跑边给用户看进度。攒到最后再一次性返回,
// 用户就只能对着转圈等 —— 账户多的时候是几十秒。
//
// `unordered: true` 是有意的:**先完成先报**。保序的话快账户要等慢账户,进度条会一卡一卡地跳,
// 那就白开流了。代价是收集成数组时顺序不定 —— 调用方按 accountId 认,别按下标。
//
// 错误通道带 SyncDepError(step 为 listAccounts / listRawCreds)—— 这两步失败意味着**整个用户
// 这一轮没法开始**,所以向上抛,不像逐账户失败那样被隔离成 ok:false。
export const syncUserStream = (
  userId: string,
): Stream.Stream<AccountSyncResult, SyncDepError, SyncServices> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* AccountStore;
      // 两次读互不依赖 → 并发取。都拿到了才知道要同步哪些账户,所以这段在流开始之前。
      const [accounts, rawList] = yield* Effect.all([store.list(), store.rawCreds()], {
        concurrency: 2,
      });
      const credsById = new Map(rawList.map((r) => [r.id, r.creds]));
      // 有界并发。**整条链留在同一个 Effect / Stream 里** —— 中间夹一层 runPromise 会切断上下文,
      // 假时钟就推不动各账户内部的退避(时序测试挂不上)。
      return Stream.fromIterable(accounts).pipe(
        Stream.mapEffect(
          (account) => syncAccount(userId, account, credsById.get(account.id) ?? null),
          { concurrency: SYNC_CONCURRENCY, unordered: true },
        ),
      );
    }),
  );

// 同上,但等全部跑完再给一份完整结果。给不需要进度的调用方(以及测试)。
export const syncUser = (userId: string): Effect.Effect<SyncResult, SyncDepError, SyncServices> =>
  syncUserStream(userId).pipe(
    Stream.runCollect,
    Effect.map((chunk) => ({ results: Chunk.toArray(chunk) })),
  );

// **只同步一个账户**(队列 consumer 一条消息一个账户,FOL-86)。与 `syncUserStream` 同样的两次读、
// 同一个 `syncAccount`,只是不经 Stream:一个账户用不着有界并发的流(`Stream.unwrap` + `mapEffect`
// 的队列、子 fiber、分块),而那套机器在一条总共该 10ms 的消息里是实打实的开销(FOL-83 第二轮)。
// 名单里没有它(两次投递之间被归档 / 删了,或不是可同步账户)→ `none`,与流的「一个都没产出」同义。
export const syncOne = (
  userId: string,
  accountId: string,
): Effect.Effect<Option.Option<AccountSyncResult>, SyncDepError, SyncServices> =>
  Effect.gen(function* () {
    const store = yield* AccountStore;
    const [accounts, rawList] = yield* Effect.all([store.list(), store.rawCreds()], {
      concurrency: 2,
    });
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return Option.none();
    const creds = rawList.find((r) => r.id === accountId)?.creds ?? null;
    return Option.some(yield* syncAccount(userId, account, creds));
  });
