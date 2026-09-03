# 0051 — PWA 冷启动闪屏 + 更新流:闪屏静默换版、运行中弹提示

日期:2026-09-02。状态:已接受。**取代 [ADR 0027](0027-pwa-installable-shell-hand-rolled-runtime-sw.md) 的「更新流」一节**(0027 其余部分——手搓 runtime SW、`swRoute` 缓存策略、可安装外壳、安全区——一字不改仍生效)。见 Linear FOL-61。

## 背景

Folio 主要作为 PWA 在手机上用。两个观感缺口:

1. **冷启动白屏。** 从点主屏图标到画出内容,中间有「OS 启动图 → 取 HTML(network-first,不缓存)→ 首帧绘制」几段。首帧要等 head 里**渲染阻塞的 appCss**;而登录后整树 `ssr:false`(ADR 0049),客户端还得 hydrate + 跑 loader 才有内容。这中间一段不像原生 App。

2. **更新无感。** ADR 0027 定的是「单用户自托管、静默 `skipWaiting + clients.claim`、不弹任何提示」。结果用户完全不知道换没换版本,也无法主动触发。

FOL-61 要把冷启动做得像一款手机软件,并让用户能**感知**并**主动**更新——这与 0027「不弹提示」直接冲突,故立此 ADR 反转其更新流部分。

## 决定

### 一、冷启动闪屏(splash)

- **splash 包住页面,未放行前把页面「不画出来」而非「盖住」**(2026-09-03 修订):`<SplashScreen>{children}</SplashScreen>`,未放行时 children 设 `visibility:hidden` —— 照常 SSR / hydrate / 预热骨架,只是不绘制。**先前是同层覆盖层遮罩**,但只要页面被画进 DOM,就总有一帧可能抢在覆盖层前露脸(SSR 流式绘制时序 / iOS 合成把 fixed 覆盖层背景弄透明 / z-index 竞争都能触发,表现为登录页脚注一闪),`will-change`、DOM 排序等补丁只能收窄不能堵死。改成「不画」后没有可露脸的东西,从根上消除。首帧即见呼吸 logo + 一行阶段小字,底色跟随明暗(沿用 `THEME_INIT_SCRIPT` 首帧已设好的 `.dark`)。
- **关键样式全部内联进 `<head>`**(内联 SVG logo、底色、居中、呼吸 keyframes),**一个字节都不依赖 appCss**;并把 appCss 那条 stylesheet link 改成**非渲染阻塞**。这样覆盖层不等 appCss 就能画——装成 PWA 用时可保证不白屏。**唯一管不到的**是「取 HTML 文档本身的网络延迟」,那段由深色 OS 启动图(manifest `background_color`=`#151515`)+ iOS 启动图(见四)盖住;纯浏览器首次未缓存访问仍可能有一瞬,属平台限制。
- **放行时机**:订阅 TanStack Router `status === 'idle'`(首个路由 settle,即「骨架/登录页真在下面了」)+ **700ms floor** + **8s 硬超时**兜底。**不等真实数据**(ADR 0049 的骨架壳本就先于数据)。放行时 logo 快速放大扩散 + 整层淡出,露出下面已渲好的页面(登录 / 锁屏 / 主页,谁在下面露谁——覆盖层不需要知道是哪个)。
- **三个阶段(均对应真实状态,不编造)**:`准备中`(SSR 首帧,JS 未执行,写死在 HTML)/ `加载中`(hydrated,router pending)/ `更新中`(正在换版,仅更新路径)。文案切换 crossfade + 轻微 y 位移,复用 `EASE_OUT` / `SPRING_SWAP` token。
- **轮换「有多快走多快」**(不强制走完序列):快设备上常常只见「准备中」就散了,轮换只在真状态耗时(慢网络 / 更新)时显现。启动优先于「让动画每次被看见」。
- **`prefers-reduced-motion`**:logo 静止、放行纯淡出、文案瞬切。功能全在,只去掉动。

### 二、更新检测判据(2026-09-03 修订:改为**版本号直比**)

> **本节与三节的判据在 2026-09-03 反转过一次**,原因见下。**先前**定的是「有新版本 = SW 有 waiting 的新 worker」;**现在**是「有新版本 = 线上 sw.js 的构建版本 ≠ 本次加载的版本」。

**「有新版本」= 线上 `sw.js` 里戳的构建版本(`@sw-build`)≠ 本次加载运行的 `__APP_VERSION__`**(两者同源,都是 `git describe`)。**不再**用 SW 的 waiting 状态判定。

**为什么反转**:`swRoute` 的导航是 **network-first 且刻意不缓存 HTML**(0027 定的,带用户余额、离线显示旧余额更危险)。于是联网时每次冷启动 / 硬刷新拿到的 HTML+JS 本来就是最新——「当前在跑的版本」冷启动后即最新。这让 waiting-worker 判据语义崩了:冷启动时那个 waiting 与已加载内容**同版**,毫无可更新之物,却照样触发「静默换版 + 更新中 + reload」,表现为「冷启动没提示、进主页才弹、设置里版本已经是新的、点刷新直接跳 splash」等一连串错位。版本号直比才诚实:只有**会话开着期间上游发了新版**,已加载的 `__APP_VERSION__` 才会落后于线上 `@sw-build`。

### 三、更新流(2026-09-03 修订:诚实的「联网总是最新」)

- **冷启动 / 首次安装——什么都不弹**:内容已是最新(network-first),没有可更新的对象。SW 照常注册;若有 waiting 就静静待着(只关乎离线外壳的 sw.js 版本,与版本无关),不 reload、不 toast、不「更新中」。**这修掉了先前「冷启动强行静默换版」的空转**。
- **运行中——探到线上新版才弹**:**定时探**(每 30 分钟 + 页面重新可见时各一次)拉一次线上 `/sw.js`,`@sw-build` 与 `__APP_VERSION__` 不同 → 弹一个**常驻**(不自动消失、可手动划走)toast「有新版本 · 更新」。点「更新」→ 亮「更新中」splash(先显示 `UPDATING_MIN_MS≈600ms` 让文案看得见)→ 有 waiting 就 `SKIP_WAITING`(→ `controllerchange` reload),无则直接 reload。**去重按版本号**:同一版本只弹一次,换更新的版本才再弹。toast 划走没关系——设置页那行是随时能回去的固定入口。
- **设置页——常驻入口**:版本号 + 一颗刷新。点刷新 → `checkForUpdate()` 同款比对(拉 `/sw.js` 比版本):有则弹「有新版本 · 更新」(点它才去 splash 换版),无则「已是最新」。**刷新本身绝不直接跳 splash**——必须经 toast 的「更新」这一步。
- **SW 侧**:`install` 不 `skipWaiting`、`message` 收 `SKIP_WAITING` 才接管、`activate` 清旧桶 + `clients.claim`——**均一字不改**;`swRoute` 缓存决策也一字不改。变的只有页面侧的检测判据(waiting → 版本比)。
- **`@folio/ui` toast-store**:命令式 `toast` 需透传 `action`/`duration`(常驻 toast 靠 `duration: Infinity`)/`description`/`dismissible`,否则「带按钮的常驻 toast」发不出来。

### 四、iOS 原生启动图(`apple-touch-startup-image`)——**已移除(2026-09-03)**

> 曾按逐机型精确尺寸生成 PNG(`scripts/gen-splash.mjs` + `public/splash/*.png` + `splash-config.json` 的 `iosDevices`),用 `apple-touch-startup-image` 让加到主屏的 PWA 启动时垫一张「logo 居中在 `#151515` 底」的图,并让它与网页覆盖层的静止 logo 无缝交接。

**为什么撤掉**:它带来的复杂度(逐机型尺寸清单、生成脚本、一批二进制资源、随新机型维护)不划算,而「iOS 图标启动 → 网页 splash」本就更自然。冷启动那一瞬的深色底改由**两处便宜的兜底**盖:manifest 的 `background_color` + `SPLASH_STYLE` 里给 `html` 烤的底色(`:root.dark` 深、否则浅)。真正影响观感的是网页覆盖层「包住页面、未放行不绘制」那套(见一),启动图不是关键路径。相关代码/资源/`gen:splash` 脚本一并删除。

## Considered Options

- **闪屏也弹「有新版本」让用户点(不静默)** —— 否。冷启动本就是「重新加载」的时机,那一刻静默换版 + 「更新中」小字最顺;再要一次点击是多余打断。运行中才需要提示,因为那时不该丢用户正在看的东西。
- **靠 SW 的 waiting worker 检测更新** —— **先前选它,2026-09-03 反转**(见二/三节)。理由是「waiting = 浏览器已下好新版的确证」;但在 network-first、不缓存 HTML 的前提下,冷启动的 waiting 与已加载内容同版,判据语义崩了。改回**版本号直比**:拉线上 `sw.js` 的 `@sw-build` 与本次加载的 `__APP_VERSION__` 比——它恰好回答「线上有没有比我现在跑的更新的构建」。原先「版本号拿不到服务器构建」的顾虑不成立:`sw.js` 就在服务器上、`updateViaCache:none` 保证拿到新的。
- **保证阶段轮换每次走完(各给 floor)** —— 否(选「有多快走多快」)。强制序列会给每次冷启动加约半秒;轮换是真状态的副产品,不值得为「让动画被看见」牺牲启动速度。
- **iOS 启动图逐机型精细出图 / 一张透明 PNG 配多 media** —— 都否。逐机型是过度投入(内容只是 logo+底色);一张透明图靠不住(尺寸不匹配被忽略 + 透明填黑)。折中:一个源脚本导出精确尺寸、底色烤进图。
- **保留 0027 的全程静默** —— 否,正是本 ADR 要反转的:用户明确要能感知 + 主动更新。

## Consequences

- **appCss 改非阻塞**:碰 `__root` 的 head。改完必须核真 app 首屏无 FOUC(覆盖层在放行前盖着,遮住 appCss 落地那一下)。
- **splash 覆盖层订阅 router 状态**:住 `RootDocument`(shellComponent),与既有 `getRouteApi("__root__")` / `useSuspenseQuery` 同一层;放行/退场由 React state 驱动,覆盖层放行后卸载(一次性,SPA 导航不复现)。
- **更新会触发 reload**:闪屏静默换版、运行中点「更新」、都以一次 `location.reload()` 落地。`reloading` 守卫防 `controllerchange` 重复触发。
- **测试缝**(照 `swRoute` 的做法):splash 就绪/阶段判定抽纯函数单测;toast-store 透传单测;`swRoute` 保持原样、其测试不动。installability / 安全区 / 真机更新流靠 Lighthouse + 真机 + 目视。
- **与 #558 的协调**:本特性与 open PR #558 同改 `apps/web/src/routes/_authed/-settings/index.tsx`(#558 加版本页脚)。本 PR 的「更新状态行」不依赖 `__APP_VERSION__` 等全局、独立可跑;两者合并时手工并到同一文件。
- **明确不做**(沿用 0027 的边界):Web Push、激进离线数据缓存、iPad / 横屏 / 浅色启动图、构建期版本注入(交给 #558)。
