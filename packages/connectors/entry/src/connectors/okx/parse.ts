import type { Note, Spot } from "@folio/connectors-basic";
import type {
  OkxDetail,
  OkxFundingAsset,
  OkxPositionsResponse,
  OkxSavingsRow,
  OkxStakingOrder,
  OkxValuationResponse,
} from "@folio/okx-client";
import { tokenRef } from "@folio/oracle-ref";
import { EARN_RESIDUAL_MIN_USD, OKX_EARN_LOGO, PROVIDER_ID, STABLECOINS } from "./constants";

// 【okx 的适配层:上游形状 → folio 的 `Balance`】——**纯函数,一个都不出网**(ADR 0036)。
// 逐字搬自 `packages/connectors/provider-okx`,fixtures 一字节没动。

// amount=cashBal(现金,不含合约 uPnL —— 修 #259)、price=eqUsd/eq(市价)、value=amount×price;
// 跳过空 ccy / amount≤0;kind:spot。用 cashBal 而非 eq:统一账户里作合约保证金的币,其 eq 含合约
// 未实现盈亏,拿 eq 当持有量会把没落袋的浮盈算成现货(合约浮盈本轮走 perp,缓做,见 ADR 0031)。
// eqUsd 是 eq 的美元值,eqUsd/eq 得市价(与 uPnL 无关),再 × cashBal 得纯现货美元值。
// 冻结 note(note 重设计,balance 级单个 Note):frozenBal>0 的币,在【它自己那笔 balance】上挂一个
// `Frozen` 段(icon warning;content 一行内联文案 `${冻结数量} ${币种} · ${占该币总持有的百分比}`,
// 如 `0.5 ETH · 25%`,原币口径)。无冻结 → 无 note。
// 展示数量格式化(千分位,最多 8 位小数)。balance 级 Note 文案用。
const fmtAmount = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 8 });

export function parseBalances(details: OkxDetail[]): Spot[] {
  const out: Spot[] = [];
  for (const d of details ?? []) {
    const ccy = d.ccy;
    if (!ccy) continue;
    const amount = Number(d.cashBal ?? 0);
    if (!(amount > 0)) continue;
    const eq = Number(d.eq ?? 0);
    const price = eq > 0 ? Number(d.eqUsd ?? 0) / eq : 0; // 市价;eq=0 无从折价 → 0(交 oracle 兜底)
    const frozen = Number(d.frozenBal ?? 0);
    const row: Spot = {
      symbol: ccy,
      amount,
      price,
      value: amount * price,
      kind: "spot",
      // 场馆命名:OKX 管这个币叫 `ccy`。symbol 大写归一由本 provider 负责(见 @folio/oracle-ref)。
      tokenRef: tokenRef.issued(PROVIDER_ID, ccy.trim().toUpperCase()),
    };
    if (frozen > 0) {
      const pct = amount > 0 ? Math.round((frozen / amount) * 100) : 0;
      row.note = {
        title: "Frozen",
        icon: "warning",
        content: `${fmtAmount(frozen)} ${ccy} · ${pct}%`,
      };
    }
    out.push(row);
  }
  return out;
}

// —— 币价提示表(price hint)——
// 其余桶(资金 / 赚币)的端点**不自带美元价**;ADR 0031 弃用额外 ticker 端点。交易账户 details 里
// 每个币的 eqUsd/eq 就是它的市价(与 uPnL 无关),把它抽成一张 ccy→price 表**零额外请求**复用:
// 资金/赚币里**也在交易账户出现或是稳定币**的币能立即估值,其余留 value:0 交 oracle 兜底。
export type PriceHint = Record<string, number>;
export function buildPriceHint(details: OkxDetail[]): PriceHint {
  const hint: PriceHint = {};
  for (const d of details ?? []) {
    if (!d.ccy) continue;
    const eq = Number(d.eq ?? 0);
    const px = eq > 0 ? Number(d.eqUsd ?? 0) / eq : 0;
    if (px > 0) hint[d.ccy.trim().toUpperCase()] = px;
  }
  return hint;
}
// 币的美元单价:稳定币≈1,否则查提示表,查不到 → undefined(value 记 0,oracle 回填)。
function priceOf(symbol: string, hint: PriceHint): number | undefined {
  const s = symbol.trim().toUpperCase();
  if (STABLECOINS.has(s)) return 1;
  return hint[s];
}

// 纯解析:资金账户 assets[] → Spot[]。数量取 `bal`(含冻结);价走提示表(稳定币≈1,否则交易账户市价,
// 无 → value 0 由 oracle 兜底)。每条带 `note.group:"funding"`(不渲染,仅供账户抽屉归 Tab,复用
// Binance 的 Note.group 机制)。跳过空 ccy / bal≤0。与 IO 分离,golden test。
export function parseFunding(assets: OkxFundingAsset[], hint: PriceHint): Spot[] {
  const out: Spot[] = [];
  for (const a of assets ?? []) {
    const ccy = a.ccy;
    if (!ccy) continue;
    const amount = Number(a.bal ?? 0);
    if (!(amount > 0)) continue;
    const price = priceOf(ccy, hint);
    out.push({
      symbol: ccy,
      amount,
      price,
      value: price != null ? amount * price : 0,
      kind: "spot",
      tokenRef: tokenRef.issued(PROVIDER_ID, ccy.trim().toUpperCase()),
      // 资金钱包标记(抽屉按 note.group 分 Tab):group=funding。与 Binance 一字对齐。
      note: { title: "Funding", icon: "info", content: "Funding wallet", group: "funding" },
    });
  }
  return out;
}

// APY 小数 → 百分比串("0.03" → "3.00%")。savings `rate` / staking `apy` 均为年化小数。
const apyPct = (rate: string | number | undefined): string =>
  `${(Number(rate ?? 0) * 100).toFixed(2)}%`;

// earn 行的公共产出:算 spot、数量取总量字段、进净值,标 balance 级 Earn note(APY)+ note.group:"earn"。
// 价走提示表(同 funding);无价 → value 0 交 oracle。
function earnRow(ccy: string, amount: number, content: string, hint: PriceHint): Spot {
  const price = priceOf(ccy, hint);
  return {
    symbol: ccy,
    amount,
    price,
    value: price != null ? amount * price : 0,
    kind: "spot",
    tokenRef: tokenRef.issued(PROVIDER_ID, ccy.trim().toUpperCase()),
    note: { title: "Earn", icon: "info", content, group: "earn" },
  };
}

// 纯解析:活期出借 rows → Spot[]。数量取 amt,note `Flexible · X% APY`。跳过空 ccy / amt≤0。golden test。
export function parseSavings(rows: OkxSavingsRow[], hint: PriceHint): Spot[] {
  const out: Spot[] = [];
  for (const r of rows ?? []) {
    const ccy = r.ccy;
    const amount = Number(r.amt ?? 0);
    if (!ccy || !(amount > 0)) continue;
    out.push(earnRow(ccy, amount, `Flexible · ${apyPct(r.rate)} APY`, hint));
  }
  return out;
}

// 纯解析:链上赚币活跃订单 orders → Spot[]。每单 investData 逐条本金成行(数量取 amt),
// note `<protocol> · X% APY`。跳过空 ccy / amt≤0。链上赚币的币锁在协议里、不在交易账户,故不与
// trading 双算(质押凭证币 OKSOL/BETH 才在交易账户,那走 trading、本端点不产它们)。golden test。
export function parseStaking(orders: OkxStakingOrder[], hint: PriceHint): Spot[] {
  const out: Spot[] = [];
  for (const o of orders ?? []) {
    const label = o.protocol?.trim() || "Staking";
    for (const inv of o.investData ?? []) {
      const ccy = inv.ccy ?? o.ccy;
      const amount = Number(inv.amt ?? 0);
      if (!ccy || !(amount > 0)) continue;
      out.push(earnRow(ccy, amount, `${label} · ${apyPct(o.apy)} APY`, hint));
    }
  }
  return out;
}

// 合约持仓探测 /account/positions —— 本轮不解析 perp,只看非空即挂兜底 Note(见 ADR 0031 perp 缓做)。
// 展示金额格式化($ + 千分位,整数)。account 级 Note 文案用。
const fmtUsd = (n: number): string =>
  `$${Math.round(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

// earn 桶残差 → **计进净值的合成聚合行**(用户决策:金额已知就该进净值)。
// asset-valuation 的 earn 桶给权威美元,减去已细分的 earn 子项(savings+staking)= 未细分额 —— 这是
// 结构化 / 定期赚币的本金:它有金额(锚给的)、但**拆不开成一个个币**(无公开端点)。造一条不透明聚合行:
// value=残差 → 进净值(OKX 总额随之对上 asset-valuation);tokenRef 用 **custom:**(无注册表背书 → oracle
// 不并进真币、保留本值,见 token-ref.ts hasTrustedSymbol),balance 级中性 note 说明它是什么、group:"earn"。
// **只在可信时产**:earn 两桶都拉到(earnComplete)+ 无估不出价的 earn 项 + 残差 > 阈值。否则残差不可信
// (「拉到了但没估到价」或「没拉到」),不能拿它污染净值 → 不产。
export function earnResidualRow(
  earnBucketUsd: number,
  earnItems: Spot[],
  hint: PriceHint,
): Spot | undefined {
  let valued = 0;
  let unpriced = 0;
  for (const item of earnItems) {
    if (priceOf(item.symbol, hint) != null) valued += item.value;
    else unpriced++;
  }
  if (unpriced > 0) return undefined; // 残差不可信 → 不计
  const residual = earnBucketUsd - valued;
  if (!(residual > EARN_RESIDUAL_MIN_USD)) return undefined;
  return {
    // 无逐币构成 → symbol 用 "USD":这行的"数量"就是它的美元估值(price=1),而非某个币的枚数。
    // name 富化成人话(带 OKX 品牌),logo 用内嵌 OKX 标(经 seed.providerLogo → token,见 sync-deps)。
    symbol: "USD",
    name: "OKX Earn (Uncategorized)",
    logo: OKX_EARN_LOGO,
    amount: residual, // 美元额当"数量",price=1 → 展示 "131,026.84 USD";净值只认 value。
    price: 1,
    value: residual,
    selfPrice: 1,
    kind: "spot",
    tokenRef: tokenRef.custom(PROVIDER_ID, "EARN-UNCATEGORIZED"),
    note: {
      title: "Earn (Uncategorized)",
      icon: "info",
      content: `${fmtUsd(residual)} of fixed-term / structured earn — value from OKX, no per-coin breakdown available`,
      group: "earn",
    },
  };
}

// —— 四桶对账(asset-valuation)—— classic 桶 Note
// 本 connector 拉 trading / funding / earn;**classic(经典账户)不拉** → valuation 里它 >0 就是**整桶漏拉**,
// 挂账户级 Note 暴露(与 earn 残差不同:classic 不像 earn 有权威美元残差可直接计入,且经典账户少见,先只提示)。
// trading / funding 不做精确逐桶对账:trading 的 cashBal **故意**不含 uPnL(ADR 容忍),funding 逐币美元
// 多半交 oracle 回填、连接器内估不准 —— 硬比会持续虚报,不做(false 残差比静默更糟)。
export function classicNote(valuation: OkxValuationResponse): Note | undefined {
  const classicBucket = Number(valuation.data?.[0]?.details?.classic ?? 0);
  if (!(classicBucket > EARN_RESIDUAL_MIN_USD)) return undefined;
  return {
    title: "Classic account not synced",
    icon: "warning",
    content: `About ${fmtUsd(classicBucket)} sits in your OKX Classic account, which Folio doesn't sync`,
  };
}

// perp 兜底 Note(account 级):检测到合约持仓即挂 —— 本轮不解析浮盈(ADR 0031 perp 缓做),
// 只提示"暂未纳入",不让浮盈悄悄漏。
// perp 兜底(软):检测到**未平仓**合约持仓即挂「浮盈暂未纳入」Note(本轮不解析 perp,ADR 0031 缓做)。
// OKX /positions 可能回 pos=0 的已平仓行 → **只认非零 pos**,不对空仓账户虚报
//(与 binance 过滤 positionAmt 同理)。
export function perpNote(positions: OkxPositionsResponse): Note | undefined {
  const hasOpen = (positions.data ?? []).some((p) => Number(p.pos ?? 0) !== 0);
  return hasOpen ? perpFallbackNote() : undefined;
}

function perpFallbackNote(): Note {
  return {
    title: "Futures positions detected",
    icon: "warning",
    content: "Futures uPnL isn't included yet — coming when the perp path ships",
  };
}

// 账户级失败 Note(ADR 0030):列出没同步上的桶 + 按错因给一句提示。有凭据/权限类失败(auth code
// 50xxx)→ 提示去交易所查权限;否则(超时/瞬时)→ 下次自动补上。
export function bucketFailureNote(failed: { name: string; auth: boolean }[]): Note {
  const names = failed.map((f) => f.name).join(" / ");
  const anyAuth = failed.some((f) => f.auth);
  const tail = anyAuth ? "check the API key's permissions" : "temporary — it'll sync next time";
  return { title: "Buckets not synced", icon: "warning", content: `${names} — ${tail}` };
}
