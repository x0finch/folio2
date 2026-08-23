# per-user 服务的 userId 从 layer 参数改成 `CurrentUser`

ADR 0037 定下的那条保证是:**userId 在装配那一刻被吃掉** —— per-user 服务的方法签名里一个 user 参数都没有,拿错用户在编译期就发生不了。

它当时的**实现方式**是「每个领域一个带参 layer 工厂」:`accountStoreLayer(userId)` / `userTokenStoreLayer({ userId, namer })`,九个领域 + 三张参考层 store 各一个。装配点因此要把同一个 userId 传十来遍。

**决定:userId 改由一个 `CurrentUser` Tag 提供,装配点 provide 一次。** 服务本身不再带参数,`.Default` 是一个普通 layer;它在**建自己那一刻** `yield* CurrentUser` 读一次,绑进闭包。

```ts
// 服务侧:不带参数
export class AccountStore extends Effect.Service<AccountStore>()("db/AccountStore", {
  effect: Effect.gen(function* () {
    const database = yield* DbClient;
    const userId = yield* CurrentUser; // ← 建服务那一刻读一次
    return { list: (): Effect.Effect<AccountSafe[]> => … };
  }),
}) {}

// 装配点:一次请求给一次
const perRequest = Layer.merge(dbClientLayer(env), Layer.succeed(CurrentUser, userId));
```

## ADR 0037 的保证一个字没变

方法签名里仍然没有 userId,服务对外的 `R` 仍然是 `never`。变的只是 userId **从哪儿来** —— 从「每个领域自己的 layer 参数」变成「整次请求的上下文」。**读的时机也没变**:仍然是装配那一刻,不是每次调用。

这条很重要,因为「每次调用读一次」是另一种设计(方法的 `R` 里带 `CurrentUser`),那才会动到 0037:调用方就能在一次请求里对不同用户各跑一遍同一个服务实例。本 ADR 不走那条。

## 为什么改

**装配点上的重复不是风格问题。** `dbStoresFor(userId)` 里 userId 出现七遍、`portsFor(userId)` 里三遍,每一处都是一个能写错的地方 —— 而写错的形状是「把 A 的 userId 传给了 B 的 store」,类型上完全合法。收成一处之后,一次请求里 userId 只出现在 `perRequestLayer(userId)` 那一行。

**layer 从「每用户一份」变成「一份」。** 带参工厂每次调用返回新 layer(没有引用缓存);不带参的 `.Default` 是 `Effect.Service` 缓存过的同一个引用。「一次请求只建一个 `DbClient`」那条红线因此更稳:它现在只依赖「`perRequestLayer(userId)` 的返回值在一次 `Layer.mergeAll` 里只出现一次」,而不是十来个 layer 引用各自正确。

## 放弃了什么

**装配点看不见「谁在用 userId」了。** 以前 `dbStoresFor` 那七行明写着每个 store 都按用户建;现在只看见 `Layer.provide(base, perRequest)`,要知道谁读了 userId 得进到各个服务里看。

换回来的是**忘不掉**:`CurrentUser` 没有默认值,任何一个 per-user 服务的 layer 的 `R` 里都带着它,装配点不 provide 就编译不过。以前忘了传是传错一个变量(编译通过),现在忘了给是类型错误。

## 为什么是 `Context.Tag` 不是 `Context.Reference`

`Context.Reference` 是 Effect 给「请求级值」的那个新东西,但它**强制要 `defaultValue`**:忘了 provide 不报错,静默按默认值跑。对「这次请求是谁的」来说,那个失败模式是**跨用户读到别人的数据**,而且悄无声息。

没有默认值的 `Context.Tag` 把这个失败模式挪到编译期。代价是它留在 `R` 通道上,layer 的类型里多一个名字 —— 那正是我们要的可见性。

## 不适用的地方

- `listUserIdsWithAccounts`(cron sweep 的全表 distinct)—— 它没有「谁的」这回事,仍是裸 Effect,`R` 里只有 `DbClient`(原则 #6 的既有受控例外)。
- `global_token_ref_index` / `token_daily_prices` 两张表的 store —— 同上,`globalTokenRefIndexStoreLayer` 不读 `CurrentUser`(ADR 0022)。
- cron 刷全局映射表那条路(`withOracleWarm`)—— 压根不建 per-user 的东西,因此也不必造一个假 userId。这一条是判据本身:**要不要 `CurrentUser`,等价于「这段代码有没有『谁的』这回事」**。
