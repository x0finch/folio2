# EVM 默认取数换成 Rabby:代价是仓库里 vendoring 一份打过补丁的 wasm 签名

Status: accepted。改 [ADR 0009](0009-connector-manifest.md) 里 evm connector 的 provider 组成(Zerion → Rabby 为默认,Zerion 降为 `defaultEnabled: false` 的备源);不动 [ADR 0020](0020-tokenref-unified-naming-grammar.md) 的命名文法 —— 这一点是本次能无迁移落地的关键。

## 决定

`evm` connector 的 `providers` 改成 `[rabbyProvider, zerionProvider]`,Zerion 标 `defaultEnabled: false`。取数走 `api.rabby.io`:**不需要任何 API key**(`ZERION_API_KEY` 从必配降为可选),两个请求拿回全链的钱包代币 + DeFi 仓位。

换来的代价是三件事,都不小,所以要写下来:

**一、请求必须签名,而签名是 wasm 算的。** 不签不是「401」,是**限速档位**:同一 IP、同一端点、间隔 90 秒冷却,签名版 20 连发全过,裸请求 2 发之后就是 429、没有 `Retry-After`、等 45 秒还是 429。所以「不签也能 200」是个陷阱 —— 只看状态码会得出「签名不用」的错结论。

**二、Workers 禁止运行时编译 wasm,所以上游那个包发布的形态在这里跑不起来。** `new WebAssembly.Module(bytes)` 和 `await WebAssembly.compile(bytes)` 都抛 `CompileError: Wasm code generation disallowed by embedder`(本地 workerd 实测)。而 `@rabby-wallet/rabby-sign` 的 UMD 在**模块求值时**就走
`if (typeof window === "undefined") { new WebAssembly.Instance(new WebAssembly.Module(内联 base64), imports) }`
—— 「没有 window」正好是 Workers 的形状,于是一 import 就炸。

唯一能走的路:把 wasm 提成独立 `.wasm` 文件让**构建期**编译,再把已编译的 `WebAssembly.Module` 塞回上游 bundle。落成 `packages/connectors/providers/rabby/vendor/`:

| 文件 | 是什么 |
|---|---|
| `rabby_sign.wasm` | 31 KB,从上游 bundle 的内联 base64 提出来 |
| `sign-patched.cjs` | 49 KB,上游 UMD + 两处字符串替换(`new WebAssembly.Module(w)` → `globalThis.__RABBY_WASM__`;`WebAssembly.compile(w)` → `Promise.resolve(globalThis.__RABBY_WASM__)`) |
| `regenerate.mjs` | 从 npm 拉指定版本重新产出上面两个。**补丁是脚本打的,不许手改**;两个补丁点各须命中 1 次,否则抛错 |
| `../src/vendor.d.ts` | 两个 `declare module`,由 `sign.ts` 三斜线引用 |

**三、这是拿「有 SLA 的付费 key」换「免费但随时可能断」。** `api.rabby.io` 是钱包自用后端,没有公开契约;签名协议是逆向来的,还带一个假的 `chrome-extension://<随机>/bridge.html` 宿主指纹和一个硬编码的扩展版本号(`X-Version: 0.93.49`)。上游改算法、开始校验指纹、或加版本下限,任意一条都会让 EVM 取数**整个停掉**,而且**本地没有修的余地** —— 只能等他们发新版再重新 vendoring。留着 Zerion 正是为这一天:有 key 的人能选回去。

## 几个具体口径

- **`cache_token_list` 是那个「一次拿全链」的端点**(只收地址)。`token_list` 必须逐链问(某公开地址 69 条链有余额 → 69 个请求,不可行),`all_token_list` 在 api.rabby.io 上 404(那是 DeBank 付费 OpenAPI 的)。
- **无迁移**:rabby 的 `community_id` 就是规范 EVM chainId(抽查 15 条全中),所以 tokenRef 仍是 `evm:<chainId>/contract:0x…`,存量快照 / 代币行 / ref 索引一个字都不用改。
- **`value` 要自己算**:上游不给 `usd_value`,`value = amount × price`。
- **负债腿的符号只能我们加**:`borrow_token_list` 里的 amount 是**正数**(实测 aave3:borrow USDT amount=0.182535、price=0.9988),负债语义只体现在「它在 borrow 列表里」+ `stats.debt_usd_value`。取负挂在 **amount** 上、单价保持正 —— 下游 revalue 用 正量 × 正价 重算,挂在 value 上会被抹掉(与 Zerion 那套 `DEBT_POSITION_TYPES` 同一约定)。
- **不重复计,有现成的自检**:Σ钱包 + Σ协议净值 = $897,486 vs 上游自己的 `total_usd_value` = $897,526(差 -0.0%)。说明两个端点各管一半。
- **dust 闸 `DUST_USD = 1`,而且只按价值筛、不按「币的质量」筛。** Zerion 有服务端 `filter[trash]=only_non_trash`,rabby 没有对应参数,所以这一刀得自己下。同一公开地址(2302 行)量过三种口径:

  | 口径 | 行数 | 丢掉的价值 |
  |---|---|---|
  | `value ≥ $0.01` 或原生币(基准) | 907 | — |
  | **`value ≥ $1`(采用)** | **444(-51%)** | **$104(-0.01%)** |
  | `value ≥ $10` | 219(-76%) | $880(-0.10%) |
  | 丢 `credit_score === 0` | 660(-27%) | $23,678(**-2.68%**) |

  按价值筛严格优于按质量筛:$1 那档砍掉一半行数,丢的价值是 credit 滤的 1/230。**质量类字段在这个端点上没用或有害**:`is_core` / `is_verified` / `is_wallet` 全 true、`is_scam` / `is_suspicious` 全 false —— 一行都滤不掉(`cache_token_list` 本身就是 core-only 那份:它的 eth 行数与 `token_list?chain_id=eth&is_all=false` 实测同为 1082,所以老仓库那个 `token.isCore` 滤搬过来是空转)。`credit_score` 有区分度,但它删的是**有价格的** memecoin(SNEZHOK $7363、WCHAN $2940…)而留下便宜但「体面」的行,方向反了;而且它没有文档,`0` 也可能只是「还没数据」,于是用户刚买的新币会静默消失。原生币无条件豁免(否则某条链会整个从视野消失)。
- **并发闸 8 次/秒**:rabby 掐的是瞬时并发而非总量 —— 串行 150 发零 429,但 20 并发掉 5 发、第二轮 14 并发掉 12 发,且被压过之后恢复慢。而 `SYNC_CONCURRENCY = 6` × 每账户 2~3 发 = ~12,正压在坎上。策略是**从不撞**:provider 自己那两发串行 + 模块级时隙闸。别指望重试 —— `RETRY_MAX_MS` 只有 5s,比 rabby 的恢复窗口短。
- **签名失败归 `AUTH_FAILED`(不可重试)**,不是 `UPSTREAM_ERROR`:它和「凭据被远端拒绝」同类 —— 重试没意义、要人介入(通常意味着上游改了协议)。错标成可重试会让三次退避全白打还盖住真原因。
- **`sign.ts` 只能按需 `await import`**,不许提到顶层:它顶层 import `.wasm`,而那个只在 Workers 运行时 / 构建链里解析得动 —— 顶层引它,任何在普通 node 环境加载 registry 的地方(entry 的 registry 测试、app 的 jsdom 单测)都会当场炸。顺带也让 wasm 不进 Worker 的启动路径。

## Considered Options

- **不迁,留着 Zerion** —— 零风险、零 vendoring。否:但也放弃了「自托管者少配一个 key」这个实打实的门槛降低。**这个选项被认真考虑过并推荐过**,是用户在知道全部代价后选择迁的。所以本 ADR 的价值不在「为什么迁」,而在把代价钉在纸上,便于将来回退。
- **不签名,靠退避扛限速** —— 不用 vendoring。否:2 发/40 秒的桶连一个账户一轮同步都跑不完,而且退避上限 5s 远短于恢复窗口。
- **纯 TS 重写签名** —— 仓库里没有混淆代码。否:那份 wasm 是刻意混淆的反滥用措施,逆向成本高,且上游一改就得重来 —— 比 vendoring 更脆。
- **签名放到 Worker 之外**(自建中继/VPS) —— Worker 里干净。否:给一个「只需 CF 账号」的自托管应用加一个常驻服务器依赖,是本项目最不该付的代价。
- **本地开发经一个部署在 CF 上的中继绕限速** —— 原计划里有这一节。否:**前提被实测推翻** —— 限速跟出口 IP 无关,跟签名有关。本地 Node 签名版 40 连发全 200,不需要中继。
- **用 pnpm `patchedDependencies` 代替 vendoring 那个 49 KB blob** —— 仓库里只剩 wasm + 一个能读的 diff,review 友好。**没否,只是没做**:vendoring 那版已经端到端验过(dev / 构建产物 / 真打 rabby),换形态要把整条链重验一遍,收益是纯美观。留作后续清理。
- **dust 闸设 $0.01** —— 几乎不丢任何东西。否:907 行里有一半是 $1 以下、没人特意持有的碎渣,白占快照。$1 砍掉它们只丢总额的 0.01%。
- **dust 闸抬到 $10 贴近 Zerion 的行数** —— 219 行 ≈ Zerion 的 188 行。否:$10 开始吞真实的小额持仓,而行数爆炸只在「几千个空投垃圾」的极端地址上发生。常量单点可改,想要 Zerion 口径的人自己抬。
- **照抄老仓库的 `token.isCore` 过滤** —— 现成的。否:实测在 `cache_token_list` 上一行都滤不掉(该端点本身就是 core-only)。
- **用 `credit_score` 过滤低质量币** —— 唯一有区分度的质量字段。否:见上表,它砍 27% 行数却丢 2.68% 的价值,删的正是有价格的持仓;还是个没文档的字段,`0` 可能只表示「暂无数据」,会让刚买的新币静默消失。

## Consequences

- 自托管少一个必配 secret(`ZERION_API_KEY` → 可选)。EVM 与 Bitcoin 现在都不要 key。
- 仓库里多了 80 KB vendoring 产物,其中 49 KB 是混淆代码 —— code review 看不了内容,只能看 `regenerate.mjs` 是否忠实。Biome 已 exclude `vendor/`。
- **快照行数会涨**:同一地址 Zerion ~188 行、rabby 443 行(dust 闸 $1 之后;闸设 $0.01 时是 908 行)。普通地址差距远没这么大,但存储与列表渲染要能吃下这个量级。
- 与 Zerion 的总额会有个位数到十几个百分点的差异,**差异集中在长尾 memecoin 的定价分歧上**(实测某地址 -12.2%,而主流币全在 3% 以内:KNC -0.2%、ETH +2.8%)。两家都不算错,但用户切换备源时会看到总额跳变。
- 上游一断,EVM 取数**整个停摆**,恢复要等上游发版 + 重新 vendoring。缓解只有一条:切回 Zerion(需要 key)。
- 签名的正确性**只有 workerd 里才验得了**(node 允许运行时编译 wasm,过了是假绿灯)。所以 `sign.ts` 没有 node 单测,靠的是构建产物上的真机验证。这是一个已知的测试缺口,不是遗漏。
