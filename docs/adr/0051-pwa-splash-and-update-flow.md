# 0051 — PWA 冷启动闪屏 + 更新流:闪屏静默换版、运行中弹提示

日期:2026-09-02。状态:已接受。**取代 [ADR 0027](0027-pwa-installable-shell-hand-rolled-runtime-sw.md) 的「更新流」一节**(0027 其余部分——手搓 runtime SW、`swRoute` 缓存策略、可安装外壳、安全区——一字不改仍生效)。见 Linear FOL-61。

## 背景

Folio 主要作为 PWA 在手机上用。两个观感缺口:

1. **冷启动白屏。** 从点主屏图标到画出内容,中间有「OS 启动图 → 取 HTML(network-first,不缓存)→ 首帧绘制」几段。首帧要等 head 里**渲染阻塞的 appCss**;而登录后整树 `ssr:false`(ADR 0049),客户端还得 hydrate + 跑 loader 才有内容。这中间一段不像原生 App。

2. **更新无感。** ADR 0027 定的是「单用户自托管、静默 `skipWaiting + clients.claim`、不弹任何提示」。结果用户完全不知道换没换版本,也无法主动触发。

FOL-61 要把冷启动做得像一款手机软件,并让用户能**感知**并**主动**更新——这与 0027「不弹提示」直接冲突,故立此 ADR 反转其更新流部分。

## 决定

### 一、冷启动闪屏(splash)

- **一张 SSR 覆盖层盖住一切**,首帧即见呼吸 logo + 一行阶段小字,底色跟随明暗(沿用 `THEME_INIT_SCRIPT` 首帧已设好的 `.dark`)。
- **关键样式全部内联进 `<head>`**(内联 SVG logo、底色、居中、呼吸 keyframes),**一个字节都不依赖 appCss**;并把 appCss 那条 stylesheet link 改成**非渲染阻塞**。这样覆盖层不等 appCss 就能画——装成 PWA 用时可保证不白屏。**唯一管不到的**是「取 HTML 文档本身的网络延迟」,那段由深色 OS 启动图(manifest `background_color`=`#151515`)+ iOS 启动图(见四)盖住;纯浏览器首次未缓存访问仍可能有一瞬,属平台限制。
- **放行时机**:订阅 TanStack Router `status === 'idle'`(首个路由 settle,即「骨架/登录页真在下面了」)+ **700ms floor** + **8s 硬超时**兜底。**不等真实数据**(ADR 0049 的骨架壳本就先于数据)。放行时 logo 快速放大扩散 + 整层淡出,露出下面已渲好的页面(登录 / 锁屏 / 主页,谁在下面露谁——覆盖层不需要知道是哪个)。
- **三个阶段(均对应真实状态,不编造)**:`准备中`(SSR 首帧,JS 未执行,写死在 HTML)/ `加载中`(hydrated,router pending)/ `更新中`(正在换版,仅更新路径)。文案切换 crossfade + 轻微 y 位移,复用 `EASE_OUT` / `SPRING_SWAP` token。
- **轮换「有多快走多快」**(不强制走完序列):快设备上常常只见「准备中」就散了,轮换只在真状态耗时(慢网络 / 更新)时显现。启动优先于「让动画每次被看见」。
- **`prefers-reduced-motion`**:logo 静止、放行纯淡出、文案瞬切。功能全在,只去掉动。

### 二、更新检测判据

**「有新版本」= Service Worker 有 waiting 的新 worker(`updatefound` 到 `installed` 且已有旧版 controller)**,**不是**比对版本号字符串。#558 注入的 `__APP_VERSION__` 等只是「当前跑的是哪份」的展示,不参与检测。

### 三、更新流(反转 0027)

- **闪屏阶段——静默换版**:冷启动发现 waiting worker → 自动 `postMessage SKIP_WAITING` → 显示「更新中」→ `controllerchange` reload 到新版。**首次安装(无旧 controller)不触发**——那次新版随 `activate` 自然接手。
- **运行中——弹提示**:`updatefound` 或**定时探**(`registration.update()`,每 30 分钟 + 页面重新可见时各一次)发现 waiting → 弹一个**会自动消失、可忽略**的 toast「有新版本 · 更新」。点「更新」→ 亮回「更新中」splash → `SKIP_WAITING` → reload。之所以不强制打断:运行中静默 reload 会丢正在看的东西。**去重**:同一个 waiting 版本只弹一次(按 waiting worker 身份记住已弹过),后续定时探到同版本不重复弹;等更新的版本装进来(新 `updatefound`)才再弹。toast 溜走没关系——设置页那行是随时能回去更新的固定入口。
- **设置页——常驻入口**:一行状态。有 waiting 显「有新版本 · 更新」,点即换版;无则显「已是最新」,点触发一次**手动 `registration.update()`**。给用户一个主动查的固定口子,不必被动等 toast。
- **SW 侧改动**:`install` 里**不再** `skipWaiting`(新版停在 waiting);加 `message` 监听,收 `{type:"SKIP_WAITING"}` 才接管;`activate` 的 `clients.claim` + 清旧桶保留。页面侧监听 `controllerchange` → reload 一次(`reloading` 守卫防重复)。**`swRoute` 缓存决策一字不改。**
- **`@folio/ui` toast-store**:命令式 `toast` 先前吞掉了 `action`/`duration`/`description`/`dismissible`(底层 `AnimatedToast` 与渲染层都支持,只是 store 没透传)→ 补透传,否则「带按钮的常驻 toast」发不出来。

### 四、iOS 原生启动图(`apple-touch-startup-image`)

iOS 不认 manifest 的 `background_color`,加到主屏的 PWA 启动时若无启动图就露空白。

- **一个源,脚本 fan-out**:作者只画一次(logo 居中 + `#151515` 底),生成脚本(照 `scripts/gen-icons.mjs` 形状)按 iPhone 竖屏的若干**精确像素尺寸**各导一张 PNG。「多张」的原因**不是美术、是 iOS 的尺寸匹配规则**(尺寸对不上的那条它直接忽略)。
- **底色烤进图,不用透明**:`apple-touch-startup-image` 的透明区 iOS 填**黑**(非 `#151515`、不跟随明暗),故把底色画进 PNG。
- **深色一套、仅竖屏**:manifest 已锁 `orientation: portrait` → 免横屏;iPad / 浅色先不做——尺寸对不上的机型自动降级成「纯深色 + logo」,接缝是同底色、看不出。
- **与覆盖层无缝交接**:启动图里 logo 的**大小与位置** == splash 覆盖层呼吸 logo 的静止态(scale 1)。「splash logo 尺寸」因此是一个共享常量,生成脚本与覆盖层同读。静态 logo → 同一个 logo 开始呼吸,连贯。

## Considered Options

- **闪屏也弹「有新版本」让用户点(不静默)** —— 否。冷启动本就是「重新加载」的时机,那一刻静默换版 + 「更新中」小字最顺;再要一次点击是多余打断。运行中才需要提示,因为那时不该丢用户正在看的东西。
- **靠比对 `__APP_VERSION__` 检测更新** —— 否。版本号是构建期注入的**当前构建**标识,拿不到「服务器上有没有更新的构建」;SW 的 waiting worker 才是浏览器已经下载好新版的确证。版本号只作展示。
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
