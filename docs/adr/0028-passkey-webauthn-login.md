# Passkey / WebAuthn 生物识别登录:首因子·与密码并列,challenge 走 cookie 不加 KV

Status: accepted。片 [#283](https://github.com/x0finch/folio2/issues/283)(端到端)/ [#284](https://github.com/x0finch/folio2/issues/284)(凭据管理)/ [#285](https://github.com/x0finch/folio2/issues/285)(登录后引导,后续)。

Folio 主要在移动端使用,且已 PWA 化(ADR 0027)。iOS 16.4+ 起,主屏安装的 PWA(standalone)里可正常调 WebAuthn,登录时弹系统 passkey 对话框、用 Face ID / Touch ID 验证 —— 体验接近原生,passkey 还同步进 iCloud 钥匙串跨设备可用。真实痛点是「移动端每次输密码烦」,不是「账户被盗风险高」。据此:**passkey 定位为首因子、与密码并列**(一刷脸直接进,密码保留作后备),**不是 2FA**。

技术上用 `better-auth` 官方 `passkey` 插件(基于 SimpleWebAuthn)。两处自托管特有的地基已调研确认:**rpID 从 `BETTER_AUTH_URL` 的 host 推导**(跟着各自部署域名走,不写死);**challenge 默认走 cookie(`better-auth-passkey`),不引入 KV**,凭据落 D1 新表 `passkey`。这让原则 #9 四闸里最不确定的「无冲突 / 无新依赖」那一闸直接过 —— folio 现有 D1 + cookie 机制够用。

登录页 **Conditional UI(autofill)为主 + 显式按钮兜底**;注册第一版**只在设置页手动加**(登录后引导留后续)。

## Considered Options

- **2FA(密码 + passkey 叠加)** —— 安全性最高。否:folio 是单用户自托管,2FA 收益低、每次登录多一步,还要处理恢复;真实需求是便利登录,不是加锁。
- **首因子·逐步取代密码(passwordless-only)** —— 更激进,弱化/隐藏密码入口。否(至少第一版):自托管场景下 passkey 丢失(换手机 / 清 iCloud 钥匙串)可能把用户锁在门外,而密码后备是最简单可靠的恢复路径。保留密码并列,门槛最低。**若未来转 passwordless-only,凭据管理片的「删光 passkey 不设下限」需重审**。
- **手搓 WebAuthn(不用插件)** —— 完全掌控。否:SimpleWebAuthn 的注册/断言验证、counter 防重放、challenge 生命周期都是易错的密码学细节,插件久经使用;原则 #9 正是「优先成熟库」。
- **challenge 存 D1 / KV** —— 显式状态存储。否:插件默认 cookie 已够(challenge 是短时一次性、天然贴合请求),加 KV 是凭空多一个 binding + 依赖,违背「无新依赖」。
- **rpID 写死 / 单独配一个 env** —— 显式。否:自托管每个部署域名不同,写死会让别人的部署直接不可用;`BETTER_AUTH_URL` 已是既有配置,派生 rpID 零新增配置面。
- **注册第一版就做登录后引导 prompt** —— 采用率高。否:引导要处理「别再问我」持久状态 + 频率策略,会把主干片撑大;主干(能注册 / 能登录 / 能删)未验证前不值得。拆成独立后续片 #285。
- **登录页只做显式按钮 / 只做 conditional UI** —— 各一半。否:conditional UI 最丝滑但不是所有浏览器支持,单靠它则不支持的浏览器完全无 passkey 入口;单靠按钮则丢了 autofill 的原生感。两者并存(autofill 优先、按钮兜底、都不支持落回密码)覆盖最全。

## Consequences

- **新增 D1 表 `passkey`**:照插件官方定义手搓 Drizzle schema(沿用 `packages/db/src/auth-schema.ts` 手搓先例 —— `@better-auth/cli` 在本仓 jiti 下失败,见该文件顶部注释)。迁移 `db:generate` → **只 `db:migrate:local`**,remote 由用户自行跑。
- **`auth.ts` 插件顺序**:`passkey(...)` 加进 `plugins`,但 `tanstackStartCookies()` 必须仍在数组**最后**。
- **rpID / origin 派生**:从 `env.BETTER_AUTH_URL` 取 host 作 rpID、完整 origin 作 origin;`rpName = "Folio"`。localhost 可用于本地 dev。抽成纯函数便于单测(这是本特性少数能便宜自动化的测试缝;端到端注册/登录靠浏览器 + 真机目视)。
- **需 HTTPS + 真实域名**:WebAuthn 要安全上下文,rpID 绑域名 → 真正可用需 folio 有正式 HTTPS 域名部署(localhost dev 可测,IP 不行)。
- **凭据管理 per-user**:列表 / 命名 / 删除走 userId-scoped 读写(原则 #6),passkey 数据天然 per-user。删光 passkey 不影响密码登录,故不设「至少留一个」下限。
- **明确不做**(单独立项):Web Push(iOS 16.4+ 且要后端)、用 Face ID 给 PWA「上锁」(iOS 不提供 launch-level 保护,生物识别只能是登录流程的一环)、passwordless-only。
