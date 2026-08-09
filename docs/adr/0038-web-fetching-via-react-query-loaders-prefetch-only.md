# apps/web 的取数统一走 react-query,router loader 降为预取

`apps/web` 今天有两套取数并存。主路是 **router loader 直返数据** —— loader 里 `await` 若干 server fn,组件 `Route.useLoaderData()` 读。旁路是**少数几个 `useQuery`** —— 首页/洞察页切到非默认 Portfolio、首页切到自定义 Tab 时,数据由 react-query 拉。

刷新只有一种手段:`router.invalidate()`,全仓 **30 处**。它重跑当前匹配链上的**全部** loader —— 在首页那是 `__root`(1 个 server fn)+ `_authed`(3 个)+ 页面 loader(5 个),一次约九个往返,其中 `getPortfolioOverview` 最贵(读快照 + 富化价格)。而且它**碰不到 react-query 缓存**:那几个 `useQuery` 的数据,任何 mutation 之后都不会更新。这不是理论问题 —— 停在非默认 Portfolio 上点「立即同步」,跑完了画面也不动,今天就是这样。

**决定:`apps/web` 的服务端取数全部收进 react-query 的 `queryOptions`;router loader 只保留预取(`queryClient.ensureQueryData`);组件一律 `useSuspenseQuery`;刷新一律 `invalidateQueries` + 分层 queryKey。`router.invalidate()` 退场。**

## 为什么

直接的触发是 #263:多账户同步要「同步完一个刷一个」。服务端早就是先完成先报([`sweep.ts`](../../packages/sync/src/sweep.ts) 并发 6、`unordered: true`),前端也早就逐行收到了完成事件 —— 唯一的批处理点是把刷新压在一轮结束。要把它挪到逐账户,就得有一个**便宜到可以一秒钟发两次**的刷新。整页 `router.invalidate()` 不是。

而「定向刷新」这件事,在 loader 直返数据的形状下**没有抓手**:loader 里的 `await getPortfolioOverview()` 不是一个可寻址的东西,没有 key 可以指。要么给它一个 key,要么永远只能整页刷。

顺带修掉上面那个 bug:key 带上 `portfolioId` 之后,loader 预取的默认口径与旁路那几个 `useQuery` 收敛成同一个 key 族,一句前缀 `invalidateQueries(["portfolio","overview"])` 同时盖住默认 / 非默认 / pin 三种视图。

## 取舍:`staleTime` 不设 0,所以那 30 处必须全部改写

这是本 ADR 里唯一一个**主动选择付出代价**的地方,单独记下来,因为它有一条明显更省事的路而我们没走。

`ensureQueryData` 只在数据 stale 时才真拉。所以 **`staleTime: 0` 的话,那 30 处 `router.invalidate()` 一行都不用改** —— loader 重跑 → 数据永远算旧 → 真拉 → 画面更新,与今天完全等价。迁移就成了纯增量的加层,回归风险接近零。

我们没选它。选了 `staleTime > 0`,理由是 hover 预加载(`defaultPreload: "intent"` + `defaultPreloadStaleTime: 0`)和页间来回导航今天**每次都真打服务器**,而这些数据在几十秒内根本不会变。开了缓存,导航才真的快。

代价说清楚:那 30 处会**静默失效**(loader 照常重跑,但数据不算 stale → 不拉),必须逐个改写成定向 `invalidateQueries`,并且这 30 条交互路径 —— 账户增删改、改凭据、打 Tag、Portfolio 增删改、切币种/语言 —— 全部要重新验一遍。漏一个的表现是「删了账户画面不变」,不会有任何报错。**这是本次迁移的主要风险,切片时单独对待。**

## 其余几条,连带的理由

**分层 key,不是平铺。** `["portfolio","overview",portfolioId,pin]` 而不是 `["portfolio-overview", id]`。前缀就是粒度 —— 改了 Tag 刷 `["tags"]` 一句盖住,不用手写列举「要刷哪五个 key」。定向刷新的可维护性全押在这上面;平铺键漏一个就是一个不刷新的 bug,而这类 bug 没有报错。

**`useSuspenseQuery` + `startTransition`,不是 `useQuery` + `keepPreviousData`。** 切 Portfolio 时 queryKey 变化会 suspend,今天靠 `placeholderData: keepPreviousData` 兜住「不闪回骨架」。改用 Suspense 之后,把 `select` 包进 `startTransition` 就是 React 自带的同一件事 —— 少维护一套并行机制,而且 `data` 恒非 `undefined`,首页/洞察页那三处 `isDefault ? loaderData : query.data` 三元分支连同它们的 `undefined` 分支一起消失。

代价:`useSuspenseQuery` **没有 `enabled`**。今天 `enabled: isPinView` 的 pin 查询要改成条件渲染子组件(不在 pin 视图时那个组件压根不挂)。这是形状上的真差别,不是等价改写。

**`pendingComponent` 不动。** loader 里 `ensureQueryData` 没 resolve 时路由 pending 照常生效,首次进页骨架不变;之后 `invalidateQueries` 触发的是 background refetch,有数据就不 suspend。三个骨架组件原样保留。

## 放弃了什么

**loader 作为「这一页要什么数据」的单一阅读入口。** 今天打开一个路由文件,loader 里那几行 `await` 就是这一页的全部数据依赖,一眼看完。改完之后 loader 里只剩一串 `ensureQueryData`,真正的消费点散在组件里的 `useSuspenseQuery`。TanStack Router 提供了 loader 这个位置而我们只拿它做预取,反直觉 —— 这条 ADR 就是给未来那个「为什么不直接用 loader 返回数据」的疑问准备的答案。

补偿是 `lib/queries/<域>.ts` 与 `lib/server/<域>.ts` 一一对应:「这一页要什么」从路由文件挪到了域文件,读的入口换了地方,没有消失。
