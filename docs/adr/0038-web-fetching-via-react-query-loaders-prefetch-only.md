# apps/web 的取数统一走 react-query,router loader 降为预取

`apps/web` 今天有两套取数并存。主路是 **router loader 直返数据** —— loader 里 `await` 若干 server fn,组件 `Route.useLoaderData()` 读。旁路是**少数几个 `useQuery`** —— 首页/洞察页切到非默认 Portfolio、首页切到自定义 Tab 时,数据由 react-query 拉。

刷新只有一种手段:`router.invalidate()`,全仓 **30 处**。它重跑当前匹配链上的**全部** loader —— 在首页那是 `__root`(1 个 server fn)+ `_authed`(3 个)+ 页面 loader(5 个),一次约九个往返,其中 `getPortfolioOverview` 最贵(读快照 + 富化价格)。而且它**碰不到 react-query 缓存**:那几个 `useQuery` 的数据,任何 mutation 之后都不会更新。这不是理论问题 —— 停在非默认 Portfolio 上点「立即同步」,跑完了画面也不动,今天就是这样。

**决定:`apps/web` 的服务端取数全部收进 react-query 的 `queryOptions`;router loader 只保留预取(`queryClient.ensureQueryData`);组件一律 `useSuspenseQuery`;刷新一律 `invalidateQueries` + 分层 queryKey。`router.invalidate()` 退场。**

## 为什么

直接的触发是 #263:多账户同步要「同步完一个刷一个」。服务端早就是先完成先报([`sweep.ts`](../../packages/sync/src/sweep.ts) 并发 6、`unordered: true`),前端也早就逐行收到了完成事件 —— 唯一的批处理点是把刷新压在一轮结束。要把它挪到逐账户,就得有一个**便宜到可以一秒钟发两次**的刷新。整页 `router.invalidate()` 不是。

而「定向刷新」这件事,在 loader 直返数据的形状下**没有抓手**:loader 里的 `await getPortfolioOverview()` 不是一个可寻址的东西,没有 key 可以指。要么给它一个 key,要么永远只能整页刷。

顺带修掉上面那个 bug:key 带上 `portfolioId` 之后,loader 预取的默认口径与旁路那几个 `useQuery` 收敛成同一个 key 族,一句前缀 `invalidateQueries(["portfolio","overview"])` 同时盖住默认 / 非默认 / pin 三种视图。

## 那 30 处必须全部改写 —— 而且这不是一个可选的取舍

**本节原先写错了,实施时(#413)被 e2e 抓了出来,这里是更正后的版本。**

原文说:`ensureQueryData` 只在数据 stale 时才真拉,所以只要 `staleTime` 保持 0,那 30 处 `router.invalidate()` 一行都不用改;我们是为了「开缓存让导航变快」才主动付出改写的代价。

**这个前提是错的。** `ensureQueryData` 的实际行为是:**缓存里只要有数据就原样返回**,连 stale 都不看(`revalidateIfStale` 不开时连后台重拉都不发)。所以:

> **一个域的读一旦搬进 `ensureQueryData`,整页 `router.invalidate()` 就再也刷不动它 —— 与 `staleTime` 设成多少完全无关。**

也就是说改写那 30 处从来不是取舍,而是**这条路的入场费**:哪一片把某个域的读搬进来,哪一片就必须同时把这个域的写路径改成定向刷新,或者给还没迁的写路径一条过渡通道(实施时用的是 `useLegacyRefresh`,#416 删)。

`staleTime` 的作用因此也要重新说:它**不影响定向刷新的正确性**(`invalidateQueries` 把查询标记为 invalid,挂载中的观察者无视 staleTime 立刻重拉),只决定「没人主动刷的时候,重新挂载要不要再拉一遍」。开它换来的是页间来回导航不重复请求,仅此而已 —— 是纯收益,不是拿风险换的。

风险本身没有变,只是归因变了:那 30 条交互路径 —— 账户增删改、改凭据、打 Tag、Portfolio 增删改、切币种/语言 —— 漏一个的表现仍然是「删了账户画面不变」,仍然不会有任何报错。**它仍是本次迁移的主要风险,切片时单独对待。**

## 其余几条,连带的理由

**分层 key,不是平铺。** `["portfolio","overview",portfolioId,pin]` 而不是 `["portfolio-overview", id]`。前缀就是粒度 —— 改了 Tag 刷 `["tags"]` 一句盖住,不用手写列举「要刷哪五个 key」。定向刷新的可维护性全押在这上面;平铺键漏一个就是一个不刷新的 bug,而这类 bug 没有报错。

**`useSuspenseQuery` + `startTransition`,不是 `useQuery` + `keepPreviousData`。** 切 Portfolio 时 queryKey 变化会 suspend,今天靠 `placeholderData: keepPreviousData` 兜住「不闪回骨架」。改用 Suspense 之后,把 `select` 包进 `startTransition` 就是 React 自带的同一件事 —— 少维护一套并行机制,而且 `data` 恒非 `undefined`,首页/洞察页那三处 `isDefault ? loaderData : query.data` 三元分支连同它们的 `undefined` 分支一起消失。

代价:`useSuspenseQuery` **没有 `enabled`**。今天 `enabled: isPinView` 的 pin 查询要改成条件渲染子组件(不在 pin 视图时那个组件压根不挂)。这是形状上的真差别,不是等价改写。

**`pendingComponent` 不动。** loader 里 `ensureQueryData` 没 resolve 时路由 pending 照常生效,首次进页骨架不变;之后 `invalidateQueries` 触发的是 background refetch,有数据就不 suspend。三个骨架组件原样保留。

## 修订(#488):「一律 `useSuspenseQuery`」加一条例外,`pendingComponent` 那句在首页不再成立

上面那句「组件**一律** `useSuspenseQuery`」写的时候,一个页面只有一拍:数据到齐,画面亮。首页改成渐进渲染(#488)之后,同一屏上有**成本差一个数量级的几条读**,「一律挂起」就变成了「一律等最慢的那条」——正是那条 ADR 想解决的问题换了个位置又长出来。

**修订后的规则:一条读要不要挂起,取决于它没到位时那一格能不能画。**

- **那一格没它就画不出来 → `useSuspenseQuery`。** 首页的总览(持仓列表、总净值)、tab 条那条轻请求都是这样:数据没到,那一格根本没有内容可言,交给 Suspense 边界统一出骨架。这仍是**默认**。
- **那一格没它照样画得出来,只是少一块 → `useQuery`。** 首页有三处:净值曲线、24h 盈亏(两个 scope)。盈亏没到时各行的市值、hero 的总净值全都是对的,只有盈亏位画骨架;曲线没到时 hero 的数字照常显示。把它们改成挂起,等于让最慢的那条读重新决定整块的节奏。

判据是「**没它能不能画**」,不是「这条读快不快」——快慢会变,而「这一格的内容依赖谁」是结构。

两条连带的代价,都实测踩过:

- **`useQuery` 在 SSR 下不等数据,`useSuspenseQuery` 等。** 于是服务端那一帧画的是「还在取数」,而数据经 query 流补下来之后客户端第一帧已经有了 —— 两帧 DOM 不同,React 判 hydration mismatch 并重画整块。治法是 `lib/hooks/use-hydrated.ts`:先与 SSR 对齐一帧,下一帧再上真内容。**任何新的非挂起读都要过这一关。**
- **请求发出的时机要自己管。** 挂起读天然「组件挂载即发」,而挂起读的组件要等它自己挂起的那条回来才挂载 —— 把非挂起读写在它里面,就等于排在挂起读后面(一个不报错的瀑布)。所以非挂起读要在**不挂起的祖先**里也调一次同一个 hook(react-query 按 key 去重),祖先负责「什么时候发」,叶子负责「读」。见 `lib/hooks/use-gains.ts`。

**`pendingComponent` 那句在首页失效了。** 首页的 loader 现在同步返回(只发请求、不 await),路由永远进不了 pending 态,所以那条路由**不设** `pendingComponent` —— 挂着是死配置。骨架改由组件内的 `QueryBoundary` 出。其余仍走 loader-await 的页面不受影响,那句话对它们照旧成立。

## 放弃了什么

**loader 作为「这一页要什么数据」的单一阅读入口。** 今天打开一个路由文件,loader 里那几行 `await` 就是这一页的全部数据依赖,一眼看完。改完之后 loader 里只剩一串 `ensureQueryData`,真正的消费点散在组件里的 `useSuspenseQuery`。TanStack Router 提供了 loader 这个位置而我们只拿它做预取,反直觉 —— 这条 ADR 就是给未来那个「为什么不直接用 loader 返回数据」的疑问准备的答案。

补偿是 `lib/queries/<域>.ts` 与 `lib/server/<域>.ts` 一一对应:「这一页要什么」从路由文件挪到了域文件,读的入口换了地方,没有消失。
