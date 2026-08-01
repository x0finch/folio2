# PWA:可安装的移动外壳(shell-only)+ 手搓 runtime-caching SW(不做离线优先、不用 workbox)

Status: accepted。见 [#262](https://github.com/x0finch/folio2/issues/262)。

Folio 主要在移动端使用,要 PWA 化:能「添加到主屏幕」、独立窗口(无地址栏)启动、有原生 App 观感,刘海机型安全区正确。**定位是「可安装的移动外壳」,不做离线优先**:Folio 是带鉴权的**实时**资产看板,把缓存里昨天的余额当实时数据显示,比诚实地报「你离线了」更糟、更危险。

据此定下 SW 策略:**只缓存 App 外壳 + 带 hash 的静态资源;所有数据/鉴权请求(`/api/*`、server functions)一律 network-only、永不进缓存**;导航请求 **network-first**(发版即拿新前端,不卡旧缓存页);离线时回退已缓存外壳、给诚实的「离线」占位,而不是伪造旧数据。

实现上 **手搓一个约 40–50 行的 `public/sw.js`(运行时缓存,按请求类型分流),不引 `vite-plugin-pwa`/workbox、不生成 precache manifest**。更新流走静默 `skipWaiting + clients.claim`。仅生产注册。图标从 `public/icon.svg` 一次性脚本产出并提交。

## Considered Options

- **`vite-plugin-pwa`(injectManifest)+ workbox** —— issue 原倾向,先 spike、冲突则回退。否(直接手搓):我们的策略很简单(hashed 静态 cache-first、导航 network-first、api 放行),workbox 的 runtime-caching / 过期 / 后台同步等重能力**基本用不上**;而它唯一值钱的 **precache manifest** 生成,恰恰要跟 TanStack Start + `@cloudflare/vite-plugin` 的双环境(client/ssr)构建集成 —— 这正是原则 #9 四闸里「无冲突」那一闸最不确定的地方。改用**运行时缓存**就根本不需要 precache manifest(外壳 HTML 与它引的 hashed JS/CSS 首次访问自然入缓存,更新靠 network-first 导航自动拿新版)。代价:首次离线访问未缓存过的资源会失败 —— 但定位本就「不做离线优先」,这点健壮性不值得为它扛构建集成风险。
- **离线缓存最近一次余额/估值,离线时展示(带「数据陈旧」标记)** —— 离线也能看点东西。否:带鉴权的实时看板里,把昨天的余额当实时看比诚实报离线更危险;「离线了」的**数据**态沿用 app 现有空/错状态即可。
- **只做 manifest + 图标 + 安全区,不做 SW** —— 省掉 SW 那片。否:Android/Chrome 的「可安装」判据要求注册了带 fetch handler 的 SW,少了它 Android 装不了(iOS 不需要 SW,但只覆盖 iOS 不够)。
- **更新流弹「有新版本,请刷新」提示** —— 让用户掌控换版时机。否:单用户自托管、network-first 导航本就每次拿新前端,再弹提示是打扰;静默 `skipWaiting + clients.claim` 更顺。
- **图标在构建期生成** —— 品牌图改了自动重产。否:图标极少变,一次性脚本产出 + 提交 PNG 更简单、无构建链依赖、无运行时成本(与仓库现有提交 `logo192/512.png` 的做法一致)。

## Consequences

- **新增 `public/sw.js`(手搓)+ 客户端注册(仅生产)**:注册在 app 挂载后进行(非模块加载期)。dev 不注册,免本地被 SW 缓存坑。
- **SW 路由策略抽成纯函数**:`fetch` handler 委托给一个可单测的 `swRoute(url, mode)`(hashed 静态 → cache-first、导航 → network-first 回退外壳、`/api/*`+server fn → network-only)。这是本特性唯一值钱的自动化测试缝;其余(installability/安全区/更新流)靠 Lighthouse + 真机 + 目视。
- **CF Workers serving**:`sw.js` 必须带 `Cache-Control: no-cache`(否则边缘缓存旧 SW,用户卡死在旧版本),scope 必须在根(`/`)。当前 `wrangler.jsonc` 无 `assets` 配置(静态资源由 `@cloudflare/vite-plugin` 接管),故 sw.js 的头与 scope 在实现时实测确认。
- **manifest 换真**:重写 `public/manifest.json`(name/short_name=Folio、`id`、`scope:"/"`、`start_url:"/"`、`display:standalone`、`categories:["finance"]`),`theme_color`/`background_color` 取 design token 的 `--background`(明暗两套走 `prefers-color-scheme` 的 `<meta>`)。`__root.tsx` head 补 `<link rel="manifest">`(当前缺)+ `apple-touch-icon` + `apple-mobile-web-app-*`。
- **图标产线**:一次性脚本从 `icon.svg` 出 192 / 512 / **maskable-512(留 ~15% 安全边)** / **apple-touch-180(实底,iOS 不吃透明)**,替掉 TanStack 默认图。扩展/换品牌图 = 重跑脚本。
- **安全区**:viewport 加 `viewport-fit=cover`,给移动顶栏补 `safe-area-inset-top`、底部导航补 `safe-area-inset-bottom`;改动会碰 `app-shell.tsx` 等有 sticky/定位的骨架,**改完必须目视核 sticky 未坏**(原则见既有「加安全区别弄坏定位」)。
- **明确不做**(单独立项):Web Push(iOS 需 16.4+ 且要后端 + 权限 UX)、激进离线数据缓存、全站移动响应式重构。
