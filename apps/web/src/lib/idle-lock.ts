// 闲置锁判定(ADR 0029 / #291）。纯函数，主动定时器与重入比对共用同一判据。
// timeoutMs = null 表示「不锁」(开关关着)；now < lastActiveAt(时钟回拨)保守处理为不锁 ——
// 威胁模型是防顺手偷看，时钟异常时宁可不误锁打扰用户。

/** 可选的闲置分钟数(pill 顺序)。单一源：设置页 pill 与 parseIdleTimeout 校验共用。 */
export const IDLE_TIMEOUT_MINUTES = [1, 5, 15, 30] as const;

/** localStorage 存超时偏好的键；值为 "1" | "5" | "15" | "30"。 */
export const IDLE_TIMEOUT_STORAGE_KEY = "folio_lock_timeout";

/**
 * 默认档:15 分钟。**注意这不是「开/关」** —— 开关是下面那个独立的键。
 * 这里只回答「开着的话多久」,所以没有 "never" 这个值(它以前兼作关闭,见 IDLE_LOCK_ENABLED_KEY)。
 */
export const DEFAULT_IDLE_TIMEOUT_RAW = "15";

/**
 * localStorage:闲置锁的开关(非空 = 开)。
 *
 * **为什么单独一个键、而不是继续用 timeout 的 "never" 档**:开关管「要不要锁」,时长管「锁多久」,
 * 两件正交的事。挤在同一组 pill 里就会出现「开关开着却选了 never」这种自相矛盾的状态,而且关掉再
 * 打开会丢掉原来选的分钟数。拆开后:关 → 这个键没了,时长偏好原样留着;再开 → 还是原来那个档。
 *
 * 与 LOCK_DEVICE_PASSKEY_KEY 也是两件事:那个记「这台设备有没有本机凭据」(注册一次就长期有效,
 * **关开关不会清它**),这个记「用户此刻想不想启用」。所以关掉再打开无须重新验证 —— 凭据还在。
 */
export const IDLE_LOCK_ENABLED_KEY = "folio_lock_enabled";

/**
 * localStorage:这台设备上那条「只能用本机生物识别」的凭据的 **WebAuthn credentialID**(#353)。
 * 非空 = 就绪。闲置锁只在就绪的设备上启用,解锁也只认 passkey。
 *
 * **存 id 而不是布尔**,因为这个 id 能回答布尔答不了的两个问题:
 * ① 设置页的 passkey 列表能标出「哪条是这台设备的」(拿它跟每行的 credentialID 比);
 * ② 删除某条 passkey 时能**精确**知道删掉的是不是本机那条 —— 布尔只能退而用「删光了才关锁」,
 *    那会漏掉「账户还剩别的设备的凭据、但本机那条被删了」的情况(锁还开着却解不开)。
 * 它不是密钥、也不是凭据摘要:passkey 的公钥/签名都在 WebAuthn 那层,这里只是个本地指针。
 *
 * **为什么存 credentialID 而不是 better-auth 那行的主键 id**:两条写入路径必须存同一种东西,而
 * 「验证一次」那条只拿得到 credentialID(WebAuthn assertion 回的 `response.id` 就是它;数据库主键
 * 那层浏览器根本不知道)。注册那条两者都有,所以统一取 credentialID。删除接口收的仍是行主键,
 * 所以列表里比对用 credentialID、调删除用 row.id,两者别混。
 *
 * **为什么是每设备的**:「这台设备现在能不能用 passkey」在 Web 上探测不到(有意的隐私设计,否则
 * 任意站点都能静默探测你有没有某账户的凭据)。而账户级的「注册过 passkey」不够 —— 两个不同 iCloud
 * 的人可以登同一个账号:A 在自己 Mac 上注册,凭据进 A 的钥匙串;B 在自己 iPhone 上登同一账号,
 * 钥匙串里什么都没有,却照样被上锁、然后解不开。所以不查,让它当场证明。
 *
 * **怎么证明:先注册,注册不下去才验证。** 注册(限定 platform 认证器,不给扫码)是铁证 —— 凭据
 * 必然落在当前设备的钥匙串里。但同一个 iCloud/Google 钥匙串在 Mac 和 iPhone 之间是**同一个认证器**,
 * 已经有一条时浏览器会按 excludeCredentials 拒掉重复注册(better-auth 服务端硬编码,没有开关),
 * 于是换设备打开这个开关必然撞上。这时改用验证一次:assertion 回的 credentialID 就是这台设备实际
 * 用掉的那条。**已知残留**:用户在那次验证里主动选了「用其他设备」扫码,记下的就会是别人设备上的
 * 凭据 —— 拦不住(WebAuthn 不让 rp 强制 transport),与下面「不是安全边界」同一档。
 *
 * **不是安全边界**:它只是「能不能开启」的前置。手改它最多是给自己开一把解不开的锁、或让锁不生效;
 * 真正的校验在 WebAuthn 那层。与 ADR 0029 已记的「懂技术的人能绕,不在威胁模型内」一致。
 */
export const LOCK_DEVICE_PASSKEY_KEY = "folio_lock_device_passkey";

export function shouldLock(opts: {
  lastActiveAt: number;
  now: number;
  timeoutMs: number | null;
}): boolean {
  if (opts.timeoutMs === null) return false; // 永不
  const elapsed = opts.now - opts.lastActiveAt;
  if (elapsed < 0) return false; // 时钟回拨，保守不锁
  return elapsed >= opts.timeoutMs;
}

// 偏好字符串 → 毫秒。合法分钟档 → 毫秒;缺失 / 非法 / 旧的 "never" → 默认档。
//
// 「不锁」不再由这里表达(旧版是 "never" → null),而是开关那一层(IDLE_LOCK_ENABLED_KEY)。
// 老用户存的 "never" 落到默认档也没事:他们的开关键不存在 → 依然不锁,与改版前行为一致。
export function parseIdleTimeout(raw: string | null): number {
  const n = Number(raw);
  return (IDLE_TIMEOUT_MINUTES as readonly number[]).includes(n)
    ? n * 60_000
    : Number(DEFAULT_IDLE_TIMEOUT_RAW) * 60_000;
}
