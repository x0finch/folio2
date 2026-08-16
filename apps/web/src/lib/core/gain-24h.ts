// 24h 盈亏(ADR 0040)——「过去 24 小时里**因为价格涨跌**赚了多少」,买卖与充提一律剔除。
// 纯逻辑,无 IO、无 Effect、无 cloudflare env:口径只在这一处定义,五个界面都不再自己算。
//
// **算法是时间加权分段(TWR)**,做组合绩效计量的行业标准。在每个能观测到的时刻把窗口切开,
// 每一小段里数量是不变的,只算价格带来的变化,再把各段合起来 —— 买卖和充提全都落在切口上,
// 自然被剔除,**不需要知道成交价**。切口 = 每一次同步的快照,所以同步越勤越准。
//
// 例(ADR 0040 里那个):24h 前 1 BTC @10.0 万;中午同步一次,BTC 10.5 万、同时变成 2 BTC;
// 现在 BTC 11.0 万。段 1(1 个)+5,000 / +5.00%;段 2(2 个)+1.0 万 / +4.76%。
// 金额 **+1.5 万**;收益率 1.0500 × 1.0476 − 1 = **+10.0%**。旧那个赚 1 万、中午那个赚 5,000,对得上。
//
// **金额与百分比是两套计算,除不通是对的**:金额是各段价值变动之和(券商报表的 investment
// gain/loss),百分比是各段收益率**连乘**。上例 1.5 万 ÷ 10 万 = 15%,而正确答案是 10% ——
// 中午加仓后本金变大,后半段那 1 万是靠 21 万赚的,不能拿 10 万当分母。简单除法会系统性高估。
// 两者只在窗口内有买卖 / 充提时才对不上;摊开解释见 #445。

// 窗口:滚动 24 小时,不是自然日(ADR 0040 记着这是权衡 —— 币市不休市、零点在哪个时区说不清)。
export const GAIN_WINDOW_MS = 24 * 60 * 60 * 1000;
// 基准点允许偏离窗口起点多远。快照是稀疏的,不会正好落在 24 小时前那一刻。
// ±2 小时:同步提到每小时之后(#446)这已经很宽;更松就会拿半天前的数冒充 24 小时。
export const GAIN_BASIS_TOLERANCE_MS = 2 * 60 * 60 * 1000;

// DeFi 协议盈亏在载荷里的键:账户 × 协议。服务端下发、客户端拼回同一条,两边必须同形。
export function defiGainKey(accountId: string, protocol: string): string {
  return `${accountId}|${protocol}`;
}

// 一条持仓线在某时刻的观测。`value` 是那一刻的冻结市值,`amount` 是数量 —— 单价由两者相除得出,
// 所以不需要单独喂价。
export interface GainPoint {
  t: number;
  amount: number;
  value: number;
}

// 一条持仓线 = 某账户持有的某个币在窗口内的观测序列(升序)。
//
// **`points[0]` 必须是基准点**(窗口起点那一刻的观测),由取数层负责:账户在窗口起点附近有快照 →
// 产一个基准点,该币不在那张快照里就产 `(t, 0, 0)`;账户压根没有那个时段的快照 → 首点会晚于
// 窗口起点,这里据此判定「算不出」。这条分工很重要:「今天新建的仓」与「这个账户没数据」在
// 数字上都是「24 小时前没有这个币」,但一个该算 0、一个该算不出。
export interface GainLine {
  points: readonly GainPoint[];
}

export interface Gain {
  amount: number;
  pct: number | null;
  // 摊开给用户看的分段(#445)。**已经合并过**:相邻的、你没动过手的段合成一段 —— 没动手的时段
  // 逐段列出来就是一串价格在慢慢爬,没有信息量,而切口本身才是要解释的东西。
  // 于是「没买卖过」只有一段(除法也刚好对得上),「买卖过」才多几行 —— 而那正是需要解释的时候。
  segments: GainSegment[];
}

// 只在本模块与 `Gain.segments` 里出现,不单独导出(knip:没有外部消费者就别开 export)。
interface GainSegment {
  from: number;
  to: number;
  openValue: number; // 段初持仓价值(各线之和)—— 这一段的收益率就是拿它当分母
  gain: number;
  pct: number | null;
  // 这一段的起点是不是一个「你动过手」的切口(相对上一段,持有数量变了)。
  // 首段恒 false —— 窗口起点不是你的动作。
  openedByChange: boolean;
}

// 阶梯取值:≤ t 的最后一个观测(与 buildPortfolioHistory 的重建语义一致 —— 快照之间保持不变)。
function at(points: readonly GainPoint[], t: number): GainPoint | undefined {
  let found: GainPoint | undefined;
  for (const p of points) {
    if (p.t > t) break;
    found = p;
  }
  return found;
}

function priceOf(p: GainPoint, fallback: number): number {
  // 数量为 0 时单价无从得出(卖光的那一笔:我们不知道它是以什么价卖的)。沿用上一段的价,
  // 于是这一段收益记 0 —— 保守,与「当天买卖的那部分丢掉」是同一种取舍,不会凭空造出盈亏。
  return p.amount !== 0 ? p.value / p.amount : fallback;
}

/**
 * 一组持仓线的 24h 盈亏。传单个 Holding 的各持有点 → 该行的数;传全部线 → 组合层的数。
 * 同一个函数两用,所以「各行相加 = 首页那个数」是结构上成立的,不是靠两边各算一遍碰对。
 *
 * 算不出(没有一条线有合格的基准点)→ `null`,由界面渲染 `—`。
 * 算得出但确实没涨没跌 → `{ amount: 0, pct: 0 }`,界面显示 0。这两件事必须分得开。
 */
export function computeGain24h(lines: readonly GainLine[], now: number): Gain | null {
  const from = now - GAIN_WINDOW_MS;
  // 合格 = 首点(基准点)落在窗口起点的容差内。太旧的基准会把「三天前到现在」冒充成 24 小时。
  const valid = lines.filter(
    (l) => l.points.length > 0 && Math.abs(l.points[0].t - from) <= GAIN_BASIS_TOLERANCE_MS,
  );
  if (valid.length === 0) return null;

  // 统一时间轴:所有合格线的观测时刻并集 + 当下。各线的切口本来各不相同(不同账户同步时刻不同),
  // 对齐到同一根轴之后,组合层才能按段汇总 —— 否则「各行相加」和「组合自己算」会是两个数。
  const axis = [...new Set([...valid.flatMap((l) => l.points.map((p) => p.t)), now])]
    .filter((t) => t <= now)
    .sort((a, b) => a - b);

  let amount = 0;
  let factor = 1;
  let compounded = false;
  const atoms: GainSegment[] = [];

  for (let i = 0; i + 1 < axis.length; i++) {
    const tA = axis[i];
    const tB = axis[i + 1];
    let segGain = 0;
    let segBase = 0;
    // 这一段的起点相对上一段,持有数量变没变 —— 变了就是「你在这儿动过手」,是个不能合并的切口。
    let changed = false;
    for (const line of valid) {
      const a = at(line.points, tA);
      if (!a) continue; // 这条线在这一段还没开始(它的基准点更晚)
      const b = at(line.points, tB) ?? a;
      const pA = priceOf(a, 0);
      const pB = priceOf(b, pA);
      // **段内数量固定为段初数量** —— 段中途的买卖被剔除的地方就是这里。
      segGain += a.amount * (pB - pA);
      segBase += a.value;
      if (i > 0) {
        const prev = at(line.points, axis[i - 1]);
        if (prev && prev.amount !== a.amount) changed = true;
      }
    }
    amount += segGain;
    // 分母 ≤ 0 的段不进连乘:空仓段没有收益率可言,而 DeFi 净负债段的「收益率」是个反向的数,
    // 连乘进去会把整条链的符号搞反。金额照常累加 —— 那部分盈亏是真的。
    if (segBase > 0) {
      factor *= 1 + segGain / segBase;
      compounded = true;
    }
    atoms.push({
      from: tA,
      to: tB,
      openValue: segBase,
      gain: segGain,
      pct: segBase > 0 ? (segGain / segBase) * 100 : null,
      openedByChange: changed,
    });
  }

  return { amount, pct: compounded ? (factor - 1) * 100 : null, segments: mergeSegments(atoms) };
}

// 相邻的、没动过手的段合成一段(#445)。合并后 `gain` 相加、`openValue` 取头一段的、`pct` 按
// 「合并后的收益 ÷ 合并后的期初」重算 —— **不是把各段百分比加起来**(那是同一个错误的另一种写法)。
//
// 结果:没买卖过的窗口只剩一段,弹层里两行、除法也对得上;买卖过才多几行,而那正是要解释的时候。
function mergeSegments(atoms: readonly GainSegment[]): GainSegment[] {
  const out: GainSegment[] = [];
  for (const seg of atoms) {
    const last = out[out.length - 1];
    if (last && !seg.openedByChange) {
      last.to = seg.to;
      last.gain += seg.gain;
      last.pct = last.openValue > 0 ? (last.gain / last.openValue) * 100 : null;
      continue;
    }
    out.push({ ...seg });
  }
  return out;
}

// —— 从快照历史装配持仓线 ——

// 余额历史里的一行(`SnapshotStore.listBalanceHistory` 的投影)。
export interface GainHistoryRow {
  accountId: string;
  takenAt: number;
  tokenId: string | null;
  amount: number;
  usdValue: number;
  // DeFi 分流用(`listBalanceHistory` 自带这两列)。代币聚合那条路不看它们;协议行要靠
  // `kind === "defi"` 把腿挑出来、再从 `metaJson` 里读协议名。manual 那条路不产这两个字段。
  kind?: string;
  metaJson?: string | null;
}

// 当下持仓(overview 的实时现推值,与首屏显示的市值同源)。
export interface GainCurrentRow {
  accountId: string;
  tokenId: string | null;
  amount: number;
  value: number;
}

const pairKey = (accountId: string, tokenId: string) => `${accountId}\u0000${tokenId}`;

/**
 * 把余额历史 + 当下持仓装配成按 `token_id` 分组的持仓线。分组键与 `aggregate.groupKey` 对齐,
 * 所以 overview 那边直接按 `holding.key` 查得到。
 *
 * 三处不显然的地方:
 *
 * ① **同一账户同一个币可能有多行**(EVM 多链、CEX 多 Wallet)—— 先按 (账户, 币, 时刻) 合并,
 *    否则一条线会变成几条互相打架的线。
 *
 * ② **该账户每个快照时刻都要产一个点,哪怕那张快照里没有这个币** —— 补 `(t, 0, 0)`。历史行里
 *    「没有这一行」表示数量是 0,而阶梯取值会把它读成「保持上一次的数量」:清仓之后曲线还挂着,
 *    今天新建的仓则被当成 24 小时前就有。这是整段装配最容易错的一步。
 *
 * ③ **末点补当下**,用 overview 的实时值 —— 与首屏那个市值同源。现在一天只同步一次(#446 之前),
 *    没有这个点的话「今天涨了多少」永远是 0:最后一张快照就是今天零点那张。
 *
 * 窗口起点的基准由 `computeGain24h` 的容差判定,这里不筛 —— 调用方按
 * `now - GAIN_WINDOW_MS - GAIN_BASIS_TOLERANCE_MS` 取历史,首点自然落在该判定的范围里。
 */
export function buildGainLines(
  history: readonly GainHistoryRow[],
  current: readonly GainCurrentRow[],
  now: number,
  // 线归到哪个组。**线本身恒是 (账户 × 币)**,变的只是怎么把它们攒成一行:
  //   · 代币行(默认)→ 按 `token_id`,与 `aggregate.groupKey` 对齐
  //   · 账户行 / 账户抽屉头 → 按 `accountId`
  //   · DeFi 协议行 → 调用方把 `tokenId` 的位置填成协议键(见 #447 第 5 片)
  // 分组换了不影响算法:`computeGain24h` 拿到几条线就在同一根轴上算几条。
  groupOf: (row: { accountId: string; tokenId: string }) => string = (row) => row.tokenId,
): Map<string, GainLine[]> {
  const byPair = new Map<string, Map<number, { amount: number; value: number }>>();
  const snapTimes = new Map<string, Set<number>>();
  for (const r of history) {
    if (r.tokenId == null) continue; // 无 token_id 的旧行归不了组(见 aggregate.groupKey)→ 算不出
    let times = snapTimes.get(r.accountId);
    if (!times) {
      times = new Set();
      snapTimes.set(r.accountId, times);
    }
    times.add(r.takenAt);
    const key = pairKey(r.accountId, r.tokenId);
    let slots = byPair.get(key);
    if (!slots) {
      slots = new Map();
      byPair.set(key, slots);
    }
    const prev = slots.get(r.takenAt);
    slots.set(r.takenAt, {
      amount: (prev?.amount ?? 0) + r.amount,
      value: (prev?.value ?? 0) + r.usdValue,
    });
  }

  const nowByPair = new Map<string, { amount: number; value: number }>();
  for (const c of current) {
    if (c.tokenId == null) continue;
    const key = pairKey(c.accountId, c.tokenId);
    const prev = nowByPair.get(key);
    nowByPair.set(key, {
      amount: (prev?.amount ?? 0) + c.amount,
      value: (prev?.value ?? 0) + c.value,
    });
  }

  const out = new Map<string, GainLine[]>();
  for (const key of new Set([...byPair.keys(), ...nowByPair.keys()])) {
    const sep = key.indexOf("\u0000");
    const accountId = key.slice(0, sep);
    const tokenId = key.slice(sep + 1);
    const slots = byPair.get(key);
    const times = [...(snapTimes.get(accountId) ?? [])].sort((a, b) => a - b);
    const points: GainPoint[] = [];
    for (const t of times) {
      if (t >= now) continue; // 末点统一由下面那个当下点承担,避免同一时刻两个点
      const slot = slots?.get(t);
      points.push({ t, amount: slot?.amount ?? 0, value: slot?.value ?? 0 });
    }
    const live = nowByPair.get(key);
    points.push({ t: now, amount: live?.amount ?? 0, value: live?.value ?? 0 });
    const group = groupOf({ accountId, tokenId });
    const lines = out.get(group);
    if (lines) lines.push({ points });
    else out.set(group, [{ points }]);
  }
  return out;
}
