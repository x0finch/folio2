# `@folio/db` 的 userId 从方法签名移到装配层

核心原则 #6 一直写着「`@folio/db` 只出包装 ops —— **userId-scoped domain functions**」,而它的字面形状是**每个函数第一批参数里有一个 `userId`**:`listAccountsByUser(env, userId)`、`writeSnapshot(env, userId, accountId, input)`,六十个方法概莫能外。审计因此很省事:签名里数得清。

参考层(#362 第 4/5 站)走的是另一条路。`runOracle(userId, …)` 按 userId **现建 per-user 的 store layer**,于是 `TokenStore` / `CacheStore` 的方法签名里一个 user 参数都没有 —— userId 在装配那一刻就被吃掉了,**拿错用户在编译期就发生不了**。

**决定:`@folio/db` 的 `queries/` 这半改用后者。** 六十个方法按领域收拢成 per-user 的 Effect 服务(`AccountStore` / `PortfolioStore` / `SettingsStore` / …),userId 由 `xxxStoreLayer(userId)` 在装配时给,方法签名里不再出现。

## 为什么改

**一致性本身不是理由** —— 仓里明写着「收益小的包可以永远不迁」。真正的理由是这两种形状**碰面了**:`apps/web` 的 server fn 一迁 Effect(#394),同一个 handler 里就会同时握着「userId 已经吃进 layer 的 oracle 服务」和「每次都要再传一遍 userId 的 db 函数」。两种约定在同一行代码里打架,而其中一种保证的是编译期的用户隔离 —— 那不是风格问题。

**同时 `queries.ts` 的「等它有 Effect 消费者再迁」触发了。** #391 把这条判据写死:没有消费者的那一半迁了只会把 `await` 换成 `yield*`。web service 层一迁,消费者就有了。

## 放弃了什么

**签名级的审计可见性。** 以前 review 一个 db 调用,userId 就在眼前;现在得往上找装配点。这是实打实的损失,不粉饰。

换回来的是**编译期的保证**:服务是按用户建的,方法压根没有"传错用户"这个入口。前者靠人看,后者靠类型 —— 在「泄露就是泄露」这件事上,后者更硬。

## 两个服务面,判据复用现成那条

六十个方法里有两个不带 userId:

- `listUserIdsWithAccounts` —— 全表 distinct,cron sweep 的入口,原则 #6 的既有受控例外
- `listBalancesForSnapshots` —— 按快照 id 取,userId 在上一步已校验

**判据不是新发明的**:原则 #6 给 `global_token_ref_index` / `token_daily_prices` 开例外用的就是「**表里有没有「谁的」这回事**」。同一条尺子:

- **有** → 进 per-user 服务。`listBalancesForSnapshots` 也进去 —— 它虽不收 userId,但只在 per-user 上下文里被调,装进去比今天靠调用方口头保证更清楚。
- **没有** → 留在外面。`listUserIdsWithAccounts` 因此是一个**裸 Effect,不是服务** —— 它塞不进 per-user 的 layer,而单独给它造一个 Tag 也不对:Tag 的意义是「可以被换掉」,这一条只有一个实现、从不被顶替(同 #392 把 `RefIndexWarmer` 去 Tag 化)。

## 服务怎么切:按领域,不是一个大服务

**不是把六十个方法塞进一个 `UserDb`。** 那只是把平铺函数换个地方摆,仍旧是「逐个方法 Effect 化」。切分照 `queries/` 现有的文件分法(它本身是照 `tests/` 切的),也就是 ADR 0012 那条按领域分的判据 —— 与 #392 把参考层五个服务收成三个时用的是同一把尺子。

方法名跟着去掉领域前缀:`createAccount` → `AccountStore.create`。服务本身就是领域,名字里再带一遍是平铺函数时代的遗留。

后缀取 `Store`(CODING.md 的第一档「精确角色后缀」),与参考层的 `TokenStore` / `CacheStore` 同款。

## 过渡期:门面的签名一个字不变

一次性翻完 = db 与 `apps/web` 同一个 PR、几千行、92 处调用点、19 个测试文件,四闸绿了也没人 review 得动。所以走 **expand → migrate → contract**:

`createDb(env)` 门面**维持现在的签名**(`db.listAccountsByUser(userId)`),内部临时「建 per-user layer + `runPromise`」。app 的调用点在整个迁移期一行不动,逐片搬走,最后连门面一起删(#394 的 T8)。

代价认下来:过渡期每次 db 调用各装一次 layer、各跑一次 `runPromise`,方向上跟这次要达成的「一次请求一次装配」相反。很轻(`drizzle(env.DB)` + 两个闭包,`connect.ts` 自己写着「不做模块级缓存,很轻,每次创建即可」),且只活到 contract 那一片。

## 连带

CLAUDE.md 的核心原则 #6 与 Security model 两处措辞同步改 —— 否则文档写着「每个 op 都收 userId」而代码里一个都看不到,下一个读到的人只会以为这是违规。
