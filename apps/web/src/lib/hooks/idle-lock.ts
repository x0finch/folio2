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
 * 与 LOCK_DEVICE_PASSKEY_KEY 也是两件事:那个记「本机能解锁的是哪条凭据」,这个记「用户此刻想不想
 * 启用」。关开关不清凭据记录(列表的 badge、删除联动都还要用它),但**打开时照样要重验一遍**——
 * 开启闲置锁是把「遮住持仓」交给生物识别,该由此刻在键盘前的人证明,不能由上次留下的记录代劳。
 */
export const IDLE_LOCK_ENABLED_KEY = "folio_lock_enabled";

/**
 * localStorage:这台设备上那条「只能用本机生物识别」的凭据的 **WebAuthn credentialID**(#353)。
 * 解锁只认 passkey。
 *
 * **它不决定锁不锁** —— 锁只看 IDLE_LOCK_ENABLED_KEY。这个键的作用是「开启时当场证明过在场」的
 * 留档,以及事后的显示(列表标「这台设备」、锁屏提示、设置页提示要不要重新登记)。曾经它还是第二道
 * 门:记录为空就放行不锁。取消了 —— 记录为空最常见的成因是清站点数据,而那正是最像「有人在动这台
 * 机器」的时刻,那时放行等于把持仓摊开;而「锁上就出不去」本来不成立,锁屏上一直有登出。
 *
 * **存 id 而不是布尔**,因为这个 id 能回答布尔答不了的两个问题:
 * ① 设置页的 passkey 列表能标出「哪条是这台设备的」(拿它跟每行的 credentialID 比);
 * ② 删除某条 passkey 时能**精确**知道删掉的是不是本机那条(该不该清标记、该不该提示重新登记);
 *    布尔只能退而用「删光了才算」,会漏掉「账户还剩别的设备的凭据、但本机那条被删了」的情况。
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
 * **怎么证明:账户已有 passkey 就先验证,验证不成才注册。**
 *
 * 验证优先,是因为大多数时候它一次就够:这台设备的钥匙串里若确实有一条,assertion 回的 credentialID
 * 就是它实际用掉的那条,比从数据库列表里猜准。反过来先注册的话,同一个钥匙串上重复注册会被
 * excludeCredentials 拒(better-auth 服务端硬编码,没有开关),而平台通常**先弹一次系统窗口、验完
 * 才告诉你「已经有了」**—— 用户白按一次指纹,然后还得再验一次。同一个 iCloud/Google 钥匙串在 Mac 和
 * iPhone 之间是同一个认证器,所以这不是边角情况。
 *
 * 注册是后备:账户压根没有 passkey,或者账户有但都在别人设备上(验证过不去)。限定 platform 认证器、
 * 不给扫码,于是成功即铁证 —— 凭据必然落在当前设备的钥匙串里。
 *
 * **已知残留**:用户在那次验证里主动选了「用其他设备」扫码,记下的就会是别人设备上的凭据 —— 拦不住
 * (WebAuthn 不让 rp 强制 transport),与下面「不是安全边界」同一档。
 *
 * **不是安全边界**:它只是「开启时的前置 + 事后的显示依据」。手改它最多让提示语不准,既绕不开锁
 * (锁看的是另一个键)也绕不开解锁(真正的校验在 WebAuthn 那层)。与 ADR 0029 已记的「懂技术的人
 * 能绕,不在威胁模型内」一致。
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
