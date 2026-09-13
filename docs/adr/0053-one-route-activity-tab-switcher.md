# 0053 — 四个 tab 合成一个路由 + Activity 保活切换,页内子状态回到组件 state(反转 0043)

日期:2026-09-04(2026-09-12 按落地补两处:进场动效、loader 多等一份)。状态:已接受。**反转 [ADR 0043](0043-in-page-tabs-in-the-url.md)**。需求原文见 Linear FOL-69(epic)/ FOL-79 / FOL-80 / FOL-81;三条页面级路线的失败记录在 PR #564。

四个顶层 page(总览 / 账户 / 洞察 / 设置)本来是四条独立路由,`<Outlet/>` 按地址换页;切 page 时旧页**被卸载**,一套「克隆内容区盖住 + motion 淡出」的转场(`TabTransition`)在中间遮丑。这套在 iOS Safari 真机上反复不成立(PR #564:motion 包 Outlet / View Transitions / DOM 盖板三条全废),根子是「切 page = 换路由」带来的退场时序问题,外加**切走真卸载 → 滚动 / 子视角 / 抽屉全丢**。

**决定:四个 page 合成一条路由(可选路径参数 `{-$page}`),由 `PageSwitcher` 用 React 原生 `<Activity>` 保活切换;页内子状态从 URL 搬回组件内部 state(反转 [ADR 0043](0043-in-page-tabs-in-the-url.md));切 page 即时,没有页间过渡 —— 新页主体只做一次逐段进场。**

网址逐字不变(`/`、`/accounts`、`/insights`、`/settings`),深链 / 后退 / 前进 / `?portfolio`(ADR 0046)全保留。变的是「谁来渲染切换」和「页内状态住哪」。

## 为什么必须是「一个路由」,不是「四条路由 + 保活」

`<Activity>` 保活要求四个 page **同时挂在树上**(隐藏的那几个 `mode="hidden"`:留 state / 留 DOM、清 effect)。而 `<Outlet/>` 只渲染当前匹配的那条路由,做不到。

真正卡死「四条路由 + 保活」这条路的是 search:保活着但不可见的账户页仍要读它自己路由的 `?search`,而那条路由此刻**不是当前 match**,`getRouteApi(它).useSearch()` 会「找不到 match 而抛」—— 这正是 `TabTransition` 时代栽的坑。收进**一条**路由后,所有 page 读的是同一条**永远是当前 match** 的路由,不再有这个问题。

## 为什么反转 0043(页内 tab 回到组件 state)

ADR 0043 把页内 tab(总览的 `tab`/`token`、洞察的 `dim`、账户的 `account`)放进 URL,为的是「刷新回原 tab、链接可分享、按 href 分键记滚动」。但在「一个路由 + 保活」模型里:

- **保活替掉了「刷新回原 tab」的大部分价值**:切走再回来,`<Activity>` 把组件 state 原样留着,连滚动都在 —— 不需要 URL 来记。
- **它们留在 URL 会把合并路由的 search 面搅浑**:每个 page 一堆自己的键,还要处理「切 page 清掉别的 page 的参数」。搬进组件 state 后,地址永远只有 `?portfolio`(+ 下面那个一次性 `?focus`),干净。

代价是这几样**不再可深链 / 分享**(0043 当初买的正是这个)。ADR 0043 自己写了「将来反悔只是改一个标志位」,这里就是行使它。判据没变(「这算不算『你在哪』」),变的是承载它的机制:从「URL」换成「组件 state + Activity 保活」。

**唯一的例外是账户页的 `?focus`**:同步面板(住在总览 / 洞察 / 设置的页头里)点某账户时,要跨页跳到账户页并定位那一行。这是**跨组件、跨页**的一次值传递,只能经地址。所以 `focus` 留在合并路由的 search 上,但它是**一次性命令**不是持久状态:账户页到达后读一次(滚动 + 高亮)即 `replace` 抹掉,事实源仍是内部 state。

## 为什么不做页间过渡(放弃交叉淡入),却留一段进场

FOL-69 原规格要 opacity 交叉淡入。spike(FOL-79)在真机上迭代后放弃了:淡入要「挂载→等就绪→两页并行淡」,带来协调器 + drain-loop + 连点收敛一整套;而**即时硬切本身就收敛**,复杂度直接归零。想靠淡入拿的两件事——内容区不闪白、离开再回来还在原样——已经由「每页自带 Suspense 骨架」+「Activity 保活」拿到了。交叉淡入不值它的复杂度。

上线前用户看了硬切的手感,要一点「进场」的编辑感(2026-09-12,规格定稿之后的口头补充):新页成为当前页时,它主体那几段内容**依次**淡入 + 轻抬 10px(`StaggerReveal`,motion 的 variants 编排)。这**不是**页间过渡:旧页没有退场、两页不同框、不需要等谁就绪、连点也不需要收敛 —— 上面那段复杂度的论证一个字不变。它只是一段进场,由每页自己裹,切换器只发「该播了」的信号(一个每次本页成为当前页就 +1 的计数,页面内读它重播)。

三条硬约束,是老坑换来的:

- **只动 opacity 与 y,绝不动 scale / filter**,而且 y 的静止值精确为 0(motion 此时写 `transform: none`)。带 transform 的层会变成后代绝对定位元素的包含块,页头那个 absolute 到外壳 `<main>` 的 `<HeaderSync/>` 一旦被裹住会顶跳 24px。所以 **`HeaderSync` 由各页渲染在进场容器之外**,它是每页都一样的常驻壳件,不参与进场。
- **不靠换 key 重挂载来重播**:那会把页面状态(滚动、展开、抽屉)一起清掉,保活就白做了。重播 = 对容器 `set("hidden")` 再 `start("visible")`。
- **`prefers-reduced-motion` → 直接 `set("visible")`**,一帧到位。以前是「本就零动画、天然满足」,现在是显式处理。

## 落地时几处不显然的地方

- **可选路径参数 `{-$page}`**:空段 = 总览,`accounts` / `insights` / `settings` 各对应一页。导航一律 `to="/{-$page}" params={{ page }}`(总览 `page: undefined` → `/`)。路由树经 **Start 的 vite 插件**在 dev / build 时重生成,**不用 `tsr generate`**(后者缺 server-router 增强块,会让 knip 误判 `router.tsx` 未用)。
- **loader 只等两样,页面数据不等**:「是哪个组合」(预取 key 要对上,ADR 0046)和**外壳同步摘要的两条原料**(账户清单 + 当下快照)。该页自己的数据 `ensureQueryData` 发出即返回,组件的 Suspense / QueryBoundary 兜加载态。切 page 时这两样早在缓存里,await 即回,切换仍即时。为什么要等第二样(2026-09-12 补):外壳用 `useSuspenseQueries` 读它们、上面没有自己的 Suspense 边界,切到一个**没看过的组合**时不等,外壳整个挂起、被 Suspense 隐掉(`display:none`)换成骨架壳几十毫秒;页头组合药丸的换字动画正好在这段里起跑,元素隐着量不到尺寸,旧名字退不出去,新旧两个名字并排卡住 —— 生产构建实测。原四个 loader 的身体抽成 `prefetch<Page>(queryClient, selectedId)`,loader 与预热共用。
- **严格 lazy**:`PageSwitcher` 维护一个只增的 `visited` 集合,没进过的 page **不进树** → 它的 `React.lazy` chunk 不请求、组件不挂载、数据不拉(守住 ADR 0038「进入 / intent 才取」)。`visited` 在渲染期并入,新页同一次提交挂载,不留空白帧。
- **pointerdown 预热**:Dock / 侧栏按下即拉那一页的 chunk + 数据。chunk 用具名动态 import,module registry 天然去重,所以预热调的和 `React.lazy` 内部调的命中同一个 module promise —— 不必手写 `once()`。
- **每页自带骨架,各是各的形状**(`-page-skeletons`):首访某 page、chunk 还在下载时由该页骨架顶着;到了原地换真页,之后 Activity 保活、回访即时无骨架。总览那张**同时就是** `AppShellSkeleton` 内容区渲的那张(同一个组件、两处渲染),冷启动「骨架壳 → 外壳 + 总览骨架 → 真页」前两段的内容区逐像素相同 —— 不是两份代码各自漂移。这些骨架只能用 `@folio/ui` 原语拼:页面自己那套岛级骨架住在各页的 chunk 里,从这儿引就把 chunk 拖进首包了。
- **一页的一切在注册表一行里**(`-pages`):懒加载组件、骨架、chunk 加载器、数据预取。切换器、路由 loader、导航预热三处都只查这张表;加第五页只改这里。页的**名字**单独放 `-page-keys`(零依赖):外壳要认「当前是哪页」,而它同文件的 `AppShellSkeleton` 必须零依赖可渲染(ADR 0049),不能牵上预取链。
- **认不出的路径段是 404**:可选参数本身不限值,`/anything` 会匹配到这条路由、外壳照渲、内容区空白。`params.parse` 里对不上注册表就抛 `notFound()`,与合并前四条独立路由的行为一致。
- **同步面板 → 账户页**仍带 `?focus`,但 `to` 换成 `to="/{-$page}" params={{ page: "accounts" }}`。
