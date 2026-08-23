# `@folio/db` 与 `@folio/oracle` 的出口形状:两张门票 + 一条连接

原则 #6 只说了「`@folio/db` 只出包装过的 op」。**没说这些 op 以什么形状出去。** 今天的答案是散装:七个领域服务各出一个名字,四个参考层端口的 layer 各出一个名字,app 的装配点为此 import 二十几行,每个 handler 各自记住自己要哪几个。

这篇定四件事,合起来就是「包外应该看见什么」。四件都在 #504 T3 的范围里,其中前两件的代码已经落地(#506),这里追认并写清替代方案;后两件是接下来 T5 / T15 要建的东西,先把判据定死。

---

## 一、底层那座桥叫 `DbClient`,`Database` 这个名字让给门票

包内唯一那处 `Effect.promise`(drizzle 的边界)原来叫 `Database`。现在叫 **`DbClient`**,`Database` 让给对外的聚合门票。

**判据是「谁更该占那个好名字」。** `Database` 是包外读到的第一个词,而包外拿到的就是「按领域包装好的数据操作」——那正是门票。桥是包内细节,**它永远不出包**(它的 `query(build)` 回调参数就是 drizzle 句柄,出包等于把包装层作废),让它占着最显眼的名字是本末倒置。

`Client` 这个后缀在本仓已经有确定含义:`packages/clients/*` 那十二个 `XxxClient` 都是「跟某个外部东西说话的那一层」。D1 也是外部东西,桥也就是那一层。CODING.md 的后缀阶梯(精确角色后缀 > 裸能力名 > `Service`)选出的也是它。

**考虑过 —— 桥留 `Database`,门票另起名(`Db` / `UserDb` / `AppData`)。** 否决:那三个名字都比 `Database` 差,而且差在**包外**。用坏名字换包内一处不出包的东西保住好名字,方向是反的。

**考虑过 —— 叫 `Drizzle` / `D1Client` / `SqlClient`。** 否决:前两个把实现绑进名字,而这层存在的目的之一就是「将来换客户端只改一处」;`SqlClient` 与 `@effect/sql` 的同名概念撞车,而我们并没有用那套。

## 二、参考层的四个端口不进 `Database`,但**自己聚合成一个 layer**

`TokenStore` / `TokenPriceStore` / `CacheStore` / `GlobalTokenRefIndexStore` 的 D1 实现住在 `@folio/db`,但**不挂到 `Database` 上**;它们合出一个 `oraclePortsLayer`,装配点一行喂给参考层。`globalTokenRefIndexStoreLayer` 仍单独可拿。

**不进 `Database` 的判据是「这个契约归谁」。** 这四个 interface 是 `@folio/oracle-basic` 定的,db 只是**一个实现**(一契约多实现,所以它们的 interface 必须独立存在)。挂到 `db.tokens` 上等于反转归属:app 会以为代币行是 db 的领域数据,而它其实是参考层的内部状态。后果不是理论上的 —— app 侧一旦能直接 `db.tokens.upsert(…)`,就绕过了 mint 那套「身份何时定死」的规矩(ADR 0021)。**T17 那张票要收窄的正是这个面**,方向一致。

**但仍然要聚合成一个 layer**,理由与 `Database` 同款:装配点不该知道参考层底下有几个端口,它要的是「把参考层的 D1 那半接上」。今天那里写着四个名字,参考层加一个端口就要改一次 app 的 import。

`globalTokenRefIndexStoreLayer` 保持单独可拿是因为**它没有「谁的」这回事**(ADR 0022):cron 刷全局映射表不带 userId,它只要这一个端口,不该被迫先造一个假用户去建另外三张 per-user 的表。

**考虑过 —— 就这么散着出四个。** 否决:装配点与参考层的端口清单被迫手工保持同步,而那份清单已经在 `OraclePorts` 类型里写了一遍。

**考虑过 —— 把它们挂到 `Database` 上。** 否决:归属反转(见上),而且直接把「绕过参考层写代币行」变成 app 的公开面。

**考虑过 —— 让 `@folio/oracle` 自己实现这四个端口。** 否决:那个包就得依赖 drizzle 与 D1,而「所有数据访问经 `@folio/db` 汇一处」是原则 #6 的整个要点。参考层定契约、db 出实现,这条分工不动。

## 三、连接由装配点开一次,红线是**一次请求一个 `DbClient`**

每一个用得着 D1 的服务(db 的领域服务、参考层的四个端口、聚合门票)**都不自己开连接** —— 它们的 `R` 通道声明 `DbClient`,由装配点建一次、一个引用分给所有人。

**代价不是性能,是状态。** `packages/db/src/connect.ts` 自己写着「`drizzle(env.DB)` 很轻,每次创建即可」——所以这条红线不是为了省那点开销。它是为了**将来**:`DbClient` 是加 span、慢查询计数、重试的唯一一处(桥只留一处的整个理由),而一次请求握着三个 client 就是把那些状态悄悄劈成三份,到时候数字对不上,查起来毫无线索。

**机制上有个坑,写在这里免得下次重犯:layer memoisation 的作用域是一次构建。** 共享同一个 layer *引用* 不够 —— 两边必须落在同一个 `Layer.mergeAll` 里、经同一次 `Effect.provide` 建起来。分两次 provide 就是两份,哪怕引用相同。这条用计数探针实测过(1 次;反向对照把 client layer 复制成两份得 2),`apps/web/src/lib/server/oracle.ts` 里有注释钉着。**已知还有一处违反**:`POST /api/sync` 装配了两次(流一次、收尾一次),修法与顺序陷阱写在 #504 T12。

**考虑过 —— 每个服务自己 `dbClientLayer(env)`。** 否决:见上,今天只是浪费,长出状态之后是错。

**考虑过 —— 一个模块级单例 client。** 否决:CF Workers 有 startup-CPU 限制(better-auth 那条教训:模块加载期不许干活),而且单例连「per-request 的状态」这个可能性都堵死了 —— 而那正是这一层将来要装的东西。

## 四、参考层也出一张门票 `Oracle`,与 `Database` 对称

handler 现在从三张票拿参考层(`TokenService` / `FxService` / `PlatformService`);改成一张 `Oracle`,字段 `tokens / fx / platforms`,取法与 `yield* Database` 对称。

**判据是 handler 的 `R` 通道该有多长。** 一个 handler 用到代币和汇率,它的 `R` 就写两个名字;再多一个域就三个。而 handler 关心的从来不是「参考层有几个服务」,是「我要参考层」。门票把「有几个」收进包内,`R` 上只剩一个名字 —— 与 db 那侧同一个道理。

**它是加在 `oracleLayer` 之上的一层,不是替换。** 三个域服务照旧存在、照旧各建各的;`Oracle` 的实现就是 yield 它们三个再挂到字段上。

**考虑过 —— 保持三张票。** 否决:见上。而且这三个名字今天散在 app 的 17 个文件里(68 处引用),每加一个域服务就是一次全仓改动。

**考虑过 —— 干脆把三个服务合成一个大服务。** 否决:那是在拆 #392 刚做完的事。三个域是按 ADR 0012 的判据切的(**领域**,不是能力),合了就等于说「代币和汇率是一回事」。门票保留三个字段,域边界一个字没动 —— 这正是聚合与合并的区别。

`GlobalRefIndexService` **不进这张票**:刷全局映射表跟 userId 无关(ADR 0022),cron 单独 provide 它 + 两个全局端口就能跑,不必先建 per-user 的三张 store。判据同第二条最后那段。

---

## 落地之后包外应该看见什么

`@folio/db`:聚合 `Database`、`oraclePortsLayer`(+ 单独的 `globalTokenRefIndexStoreLayer`)、`CurrentUser`、`dbClientLayer` 与**只出类型**的 `DbClient`、auth adapter、`listUserIdsWithAccounts`、领域类型与错误类。**七个领域服务的名字全部消失**(它们挂进门票之后没有第二个消费者,#504 T13 收割)。

`@folio/oracle`:聚合 `Oracle`、`GlobalRefIndexService`、`oracleLayer` 与类型。**三个域服务的名字同样消失。**

两侧对称是刻意的:app 侧一次请求握两张票 —— `Database` 拿自己的数据,`Oracle` 拿参考层 —— 加上一个 `CurrentUser` 说明这是谁的(ADR 0044)。
