// 假上游:perf:cpu:jobs 专用。沙箱里出网被挡,而 cron 那条写路径**每一步都要出网**(取余额、取价、
// 刷币目录)—— 不给它一个会答话的上游,量到的就是「连不上 → 报错 → 重试」那条路,不是生产那条。
//
// 一个 HTTP server,按路径前缀扮演 cron 会打的每一家:`/binance` `/okx` `/bybit` `/rabby`
// `/coinstats` `/hyperliquid` `/blockbook` `/coingecko`。worker 经 .dev.vars 里的 base URL 覆盖
// 被指过来(`upstreamVars`)—— binance / okx / bybit 那三个是生产本来就有的 #264 开关,其余几个是
// FOL-84 补的同款开关,生产不设。
//
// **确定性**:一切由「序号 + 账户标识的散列」算出来,不读时钟之外的任何东西 —— 两次运行打到的是
// 同一份数据,前后对比才有意义。形状照着各家录制的 fixture(`packages/connectors/entry/tests/
// connectors/*/fixtures`、`packages/clients/*/tests/fixtures`),带上生产响应里那些**我们不读**的
// 字段:JSON.parse 的开销按字节算,只留我们读的字段会把解析那一截量小。
//
// **一个代币宇宙,所有上游共用**:CEX 报的 symbol、链上钱包报的合约地址、CoinGecko 的目录 /
// `coins/list` / 价格,指的是同一批币 —— 否则 mint 认不出来,估值那一段就不跑,量到的是短路。
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { HOST } from "./constants.mjs";

/** `/coins/list?include_platform=true` 的规模 —— 对齐生产实测(约 18k 个币、23k 条平台地址、2.6 MB)。 */
const UNIVERSE_COINS = 18_000;
/** 有市值排名的前多少个(`/coins/markets` 能翻到的深度,目录取前 1000)。 */
const RANKED_COINS = 5_000;
/** `/asset_platforms` 的条数(生产约 400)。 */
const ASSET_PLATFORM_COUNT = 400;
/** Binance `/api/v3/ticker/price` 回多少个交易对(生产约 3000,一次全给)。 */
const BINANCE_TICKERS = 2_400;
/** 每 4 个 / 每 25 个币多挂一条链 —— 凑出生产那样「一币多链」的平台行数。 */
const SECOND_PLATFORM_EVERY = 4;
const THIRD_PLATFORM_EVERY = 25;
/** 历史价序列的点距与上限(`market_chart/range`)。 */
const CHART_STEP_MS = 3_600_000;
const CHART_MAX_POINTS = 2_000;
/** CoinGecko `/search` 最多回几条。 */
const SEARCH_LIMIT = 25;

// 各账户吐多少行。目标是「每个账户约 50 行持仓」,各家按自己的桶摊开(bitcoin 一个地址只有一行,
// 形状使然)。
const COUNTS = {
  binance: { spot: 30, funding: 8, flexible: 6, locked: 3, futures: 2, coinm: 1 },
  okx: { trading: 30, funding: 10, savings: 5, staking: 3, positions: 2 },
  bybit: { unified: 35, funding: 10, earnPerCategory: 3 },
  rabby: { tokens: 40, protocols: 3, itemsPerProtocol: 2 },
  coinstats: { coins: 50 },
  hyperliquid: { positions: 40 },
};

// 市值前列的真实币(id 与 `@folio/oracle-upstream-coingecko` 的 OVERRIDES 对齐,symbol 那一档靠它认)。
// native = 在任何链上都没有合约(`platforms` 为空)。
const MAJORS = [
  ["bitcoin", "btc", "Bitcoin", 64000, true],
  ["ethereum", "eth", "Ethereum", 3200, true],
  ["tether", "usdt", "Tether", 1, false],
  ["binancecoin", "bnb", "BNB", 580, true],
  ["solana", "sol", "Solana", 150, true],
  ["usd-coin", "usdc", "USDC", 1, false],
  ["ripple", "xrp", "XRP", 0.55, true],
  ["dogecoin", "doge", "Dogecoin", 0.12, true],
  ["the-open-network", "ton", "Toncoin", 6.1, true],
  ["cardano", "ada", "Cardano", 0.45, true],
  ["tron", "trx", "TRON", 0.12, true],
  ["avalanche-2", "avax", "Avalanche", 28, true],
  ["chainlink", "link", "Chainlink", 14, false],
  ["polkadot", "dot", "Polkadot", 6.3, true],
  ["dai", "dai", "Dai", 1, false],
  ["sui", "sui", "Sui", 1.1, true],
  ["cosmos", "atom", "Cosmos Hub", 7.2, true],
  ["uniswap", "uni", "Uniswap", 9.4, false],
  ["litecoin", "ltc", "Litecoin", 72, true],
  ["near", "near", "NEAR Protocol", 5.3, true],
];

// 平台表的头几条:真实的 EVM 链 + 我们认的三条非 EVM 链(NON_EVM_PLATFORMS)。其余补成假链。
const REAL_PLATFORMS = [
  ["ethereum", 1, "Ethereum"],
  ["arbitrum-one", 42161, "Arbitrum One"],
  ["base", 8453, "Base"],
  ["binance-smart-chain", 56, "BNB Smart Chain"],
  ["polygon-pos", 137, "Polygon POS"],
  ["optimistic-ethereum", 10, "OP Mainnet"],
  ["avalanche", 43114, "Avalanche"],
  ["solana", null, "Solana"],
  ["sui", null, "Sui"],
  ["cosmos", null, "Cosmos Hub"],
  ["tron", null, "TRON"],
];
/** 非 major 的币挂在哪几条链上轮着来(平台表的前这么多条)。 */
const HOME_PLATFORMS = 40;

// Rabby 的链 slug ↔ chainId(`/v1/chain/list`)。钱包里的币只从这两条链上挑。
const RABBY_CHAINS = [
  { slug: "eth", platform: "ethereum", chainId: 1, native: "ethereum", nativeSymbol: "ETH" },
  {
    slug: "arb",
    platform: "arbitrum-one",
    chainId: 42161,
    native: "ethereum",
    nativeSymbol: "ETH",
  },
];

const hex = (seed, n) =>
  createHash("sha256").update(`folio-perf-upstream:${seed}`).digest("hex").slice(0, n);
/** 种子串 → [0, 1) 的确定性小数。 */
const unit = (seed) => Number.parseInt(hex(seed, 8), 16) / 0x1_0000_0000;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (seed, n) =>
  Array.from(
    { length: n },
    (_, i) => BASE58[Number.parseInt(hex(`${seed}:${i}`, 2), 16) % 58],
  ).join("");

function platformAddress(platformId, seed) {
  if (platformId === "solana") return base58(seed, 44);
  if (platformId === "sui") return `0x${hex(seed, 64)}::coin::COIN`;
  if (platformId === "cosmos") return `ibc/${hex(seed, 64).toUpperCase()}`;
  if (platformId === "tron") return `T${base58(seed, 33)}`;
  return `0x${hex(seed, 40)}`;
}

function buildPlatforms() {
  const out = REAL_PLATFORMS.map(([id, chainId, name]) => ({ id, chainId, name }));
  for (let k = out.length; k < ASSET_PLATFORM_COUNT; k++) {
    // 一半是 EVM(有 chain_identifier),一半不是 —— 后者在映射表里会被记成 skipped,与生产同形。
    out.push({
      id: `perf-chain-${k}`,
      chainId: k % 2 ? null : 900_000 + k,
      name: `Perf Chain ${k}`,
    });
  }
  return out;
}

function buildCoins(platforms) {
  const coins = [];
  for (let i = 0; i < UNIVERSE_COINS; i++) {
    const major = MAJORS[i];
    const id = major ? major[0] : `pc-${i}`;
    const symbol = major ? major[1] : `p${i}`;
    const name = major ? major[2] : `Perf ${i}`;
    const price = major ? major[3] : +(0.01 + unit(`price:${i}`) * 50).toFixed(6);
    const coinPlatforms = {};
    if (!major?.[4]) {
      const home = platforms[i % HOME_PLATFORMS].id;
      coinPlatforms[home] = platformAddress(home, `${id}:${home}`);
      if (i % SECOND_PLATFORM_EVERY === 0) {
        const p = platforms[(i * 7 + 3) % HOME_PLATFORMS].id;
        coinPlatforms[p] = platformAddress(p, `${id}:${p}`);
      }
      if (i % THIRD_PLATFORM_EVERY === 0) {
        const p = platforms[(i * 13 + 5) % platforms.length].id;
        coinPlatforms[p] = platformAddress(p, `${id}:${p}`);
      }
    }
    coins.push({
      i,
      id,
      symbol,
      name,
      price,
      change24h: +((unit(`chg:${i}`) - 0.5) * 20).toFixed(4),
      rank: i < RANKED_COINS ? i + 1 : null,
      platforms: coinPlatforms,
    });
  }
  return coins;
}

/** 整个宇宙 + 那几份大响应的预编码(每发现编 2.6 MB 会把假上游自己变成瓶颈)。 */
function buildUniverse() {
  const platforms = buildPlatforms();
  const coins = buildCoins(platforms);
  const byId = new Map(coins.map((c) => [c.id, c]));
  const onPlatform = (pid) => coins.filter((c) => c.platforms[pid]);
  const coinsList = Buffer.from(
    JSON.stringify(
      coins.map((c) => ({ id: c.id, symbol: c.symbol, name: c.name, platforms: c.platforms })),
    ),
  );
  const assetPlatforms = Buffer.from(
    JSON.stringify(
      platforms.map((p) => ({
        id: p.id,
        chain_identifier: p.chainId,
        name: p.name,
        shortname: "",
        native_coin_id: p.id,
        image: {
          thumb: `https://assets.example/p/${p.id}/thumb.png`,
          small: `https://assets.example/p/${p.id}/small.png`,
          large: `https://assets.example/p/${p.id}/large.png`,
        },
      })),
    ),
  );
  const ranked = coins.filter((c) => c.rank != null);
  return {
    coins,
    platforms,
    byId,
    ranked,
    // CEX 与钱包从这几份里挑:CEX 按 symbol 认,只认得目录(前 1000)里的;钱包按合约地址认。
    catalogue: ranked.slice(0, 1_000),
    chainPools: new Map(RABBY_CHAINS.map((ch) => [ch.slug, onPlatform(ch.platform)])),
    solanaPool: onPlatform("solana"),
    coinsList,
    assetPlatforms,
    platformRows: coins.reduce((n, c) => n + Object.keys(c.platforms).length, 0),
  };
}

/** 从 pool 里按种子挑 n 个互不相同的(确定性;majors 优先放进前几个,像真账户)。 */
function pick(pool, n, seed, { majors = 0 } = {}) {
  const out = [];
  const seen = new Set();
  for (let k = 0; k < majors && k < pool.length; k++) {
    out.push(pool[k]);
    seen.add(k);
  }
  const start = Math.floor(unit(`start:${seed}`) * pool.length);
  const step = 1 + Math.floor(unit(`step:${seed}`) * 97);
  for (let k = 0; out.length < n && k < pool.length * 2; k++) {
    const at = (start + k * step) % pool.length;
    if (seen.has(at)) continue;
    seen.add(at);
    out.push(pool[at]);
  }
  return out;
}

const amountOf = (seed, coin) => {
  // 大约 $50 – $5000 一行,按价折回数量。
  const usd = 50 + unit(`amt:${seed}`) * 4_950;
  return +(usd / Math.max(coin.price, 1e-6)).toPrecision(8);
};
const str = (n) => String(n);
const upper = (c) => c.symbol.toUpperCase();

// ---------------------------------------------------------------- CoinGecko
function marketRow(c, nowIso) {
  return {
    id: c.id,
    symbol: c.symbol,
    name: c.name,
    image: `https://assets.example/coins/${c.id}/large.png`,
    current_price: c.price,
    market_cap: Math.round((c.price * 1e9) / (c.i + 1)),
    market_cap_rank: c.rank,
    fully_diluted_valuation: null,
    total_volume: Math.round((c.price * 1e7) / (c.i + 1)),
    high_24h: c.price * 1.03,
    low_24h: c.price * 0.97,
    price_change_24h: c.price * (c.change24h / 100),
    price_change_percentage_24h: c.change24h,
    market_cap_change_24h: 0,
    market_cap_change_percentage_24h: c.change24h,
    circulating_supply: 1e9 / (c.i + 1),
    total_supply: 1e9 / (c.i + 1),
    max_supply: null,
    ath: c.price * 2,
    ath_change_percentage: -50,
    ath_date: "2024-03-14T07:10:36.635Z",
    atl: c.price / 10,
    atl_change_percentage: 900,
    atl_date: "2015-10-20T00:00:00.000Z",
    roi: null,
    last_updated: nowIso,
    price_change_percentage_24h_in_currency: c.change24h,
  };
}

// **覆盖全部 `SUPPORTED_CURRENCIES`**(真 CoinGecko 的 `exchange_rates` 都有):少一个,`fx.warm()`
// 每次都判「有币种缺」而回源,量到的 `fx` 活就成了「每小时真刷一次」,而生产上 6h TTL 内它是零出网的
// 缓存命中(第二轮之前这里只有六种,`fx` 那一行因此一直偏高)。
const FX_PER_BTC = {
  usd: 64000,
  eur: 59000,
  gbp: 50400,
  cny: 457000,
  jpy: 9_550_000,
  hkd: 500_000,
  krw: 88_000_000,
  cad: 87_000,
  aud: 97_000,
  chf: 56_000,
};
const CRYPTO_PER_BTC = { eth: 25 };

function coingecko(u, path, q) {
  const nowIso = new Date().toISOString();
  if (path === "/coins/list") return { raw: u.coinsList };
  if (path === "/asset_platforms") return { raw: u.assetPlatforms };
  if (path === "/coins/markets") {
    const ids = q.get("ids");
    if (ids) {
      return {
        body: ids
          .split(",")
          .map((id) => u.byId.get(id))
          .filter(Boolean)
          .map((c) => marketRow(c, nowIso)),
      };
    }
    const perPage = Number(q.get("per_page") ?? 100);
    const page = Number(q.get("page") ?? 1);
    return {
      body: u.ranked.slice((page - 1) * perPage, page * perPage).map((c) => marketRow(c, nowIso)),
    };
  }
  if (path === "/simple/price") {
    const nowSec = Math.floor(Date.now() / 1000);
    const out = {};
    for (const id of (q.get("ids") ?? "").split(",")) {
      const c = u.byId.get(id);
      if (!c) continue;
      out[id] = { usd: c.price, usd_24h_change: c.change24h, usd_last_updated_at: nowSec };
    }
    return { body: out };
  }
  if (path === "/exchange_rates") {
    const rates = { btc: { name: "Bitcoin", unit: "BTC", value: 1, type: "crypto" } };
    for (const [code, value] of Object.entries(FX_PER_BTC)) {
      rates[code] = { name: code.toUpperCase(), unit: code.toUpperCase(), value, type: "fiat" };
    }
    for (const [code, value] of Object.entries(CRYPTO_PER_BTC)) {
      rates[code] = { name: code.toUpperCase(), unit: code.toUpperCase(), value, type: "crypto" };
    }
    return { body: { rates } };
  }
  if (path === "/search") {
    const needle = (q.get("query") ?? "").toLowerCase();
    const coins = u.ranked
      .filter((c) => c.symbol.includes(needle) || c.name.toLowerCase().includes(needle))
      .slice(0, SEARCH_LIMIT)
      .map((c) => ({
        id: c.id,
        symbol: c.symbol,
        name: c.name,
        market_cap_rank: c.rank,
        thumb: `https://assets.example/coins/${c.id}/thumb.png`,
        large: `https://assets.example/coins/${c.id}/large.png`,
      }));
    return { body: { coins, exchanges: [], categories: [], nfts: [] } };
  }
  let m = /^\/(derivatives\/)?exchanges\/([^/]+)$/.exec(path);
  if (m) return { body: { name: m[2], image: `https://assets.example/x/${m[2]}.png` } };
  m = /^\/coins\/([^/]+)\/market_chart\/range$/.exec(path);
  if (m) {
    const c = u.byId.get(m[1]);
    if (!c) return { status: 404, body: { error: "coin not found" } };
    const fromMs = Number(q.get("from")) * 1000;
    const toMs = Number(q.get("to")) * 1000;
    const prices = [];
    for (let t = fromMs; t <= toMs && prices.length < CHART_MAX_POINTS; t += CHART_STEP_MS) {
      prices.push([t, c.price * (1 + Math.sin(t / 86_400_000) * 0.05)]);
    }
    return { body: { prices, market_caps: [], total_volumes: [] } };
  }
  // 合约点查:宇宙之外的地址 → 404(client 把它读成「CGK 不认识」,正常答案)。
  if (/^\/coins\/[^/]+\/contract\//.test(path))
    return { status: 404, body: { error: "not found" } };
  return null;
}

// ---------------------------------------------------------------- CEX
function binance(u, path, seed) {
  const n = COUNTS.binance;
  const spot = pick(u.catalogue, n.spot, `binance:spot:${seed}`, { majors: 6 });
  if (path === "/api/v3/ticker/price") {
    // 一次全给,与生产同形:所有 `<SYM>USDT` 对 + 一堆和我们无关的交叉对。
    const out = u.catalogue.map((c) => ({ symbol: `${upper(c)}USDT`, price: c.price.toFixed(8) }));
    for (let k = 0; out.length < BINANCE_TICKERS; k++) {
      const c = u.catalogue[k % u.catalogue.length];
      out.push({ symbol: `${upper(c)}BTC${k}`, price: (c.price / 64000).toFixed(8) });
    }
    return { body: out };
  }
  if (path === "/api/v3/account") {
    return {
      body: {
        makerCommission: 10,
        takerCommission: 10,
        buyerCommission: 0,
        sellerCommission: 0,
        canTrade: true,
        canWithdraw: true,
        canDeposit: true,
        updateTime: 0,
        accountType: "SPOT",
        balances: spot.map((c, k) => ({
          asset: upper(c),
          free: amountOf(`b:s:${seed}:${k}`, c).toFixed(8),
          locked: k % 5 === 0 ? "0.10000000" : "0.00000000",
        })),
        permissions: ["SPOT"],
        uid: 1,
      },
    };
  }
  if (path === "/sapi/v1/asset/get-funding-asset") {
    return {
      body: pick(u.catalogue, n.funding, `binance:fund:${seed}`).map((c, k) => ({
        asset: upper(c),
        free: str(amountOf(`b:f:${seed}:${k}`, c)),
        locked: "0",
        freeze: "0",
        withdrawing: "0",
        btcValuation: "0",
      })),
    };
  }
  if (path === "/sapi/v1/simple-earn/flexible/position") {
    const rows = pick(u.catalogue, n.flexible, `binance:flex:${seed}`).map((c, k) => ({
      asset: upper(c),
      totalAmount: str(amountOf(`b:x:${seed}:${k}`, c)),
      latestAnnualPercentageRate: "0.0321",
      canRedeem: true,
      productId: `${upper(c)}001`,
    }));
    return { body: { rows, total: rows.length } };
  }
  if (path === "/sapi/v1/simple-earn/locked/position") {
    const rows = pick(u.catalogue, n.locked, `binance:lock:${seed}`).map((c, k) => ({
      asset: upper(c),
      amount: str(amountOf(`b:l:${seed}:${k}`, c)),
      apy: "0.08",
      redeemDate: 1_766_707_200_000,
      positionId: k + 1,
      duration: "90",
    }));
    return { body: { rows, total: rows.length } };
  }
  if (path === "/fapi/v2/account") {
    const positions = pick(u.catalogue.slice(0, 50), n.futures, `binance:fut:${seed}`).map(
      (c, k) => ({
        symbol: `${upper(c)}USDT`,
        positionAmt: k % 2 ? "-1.5" : "0.5",
        entryPrice: str(c.price),
        unrealizedProfit: "12.5",
        leverage: "10",
        notional: str(c.price * 0.5),
        isolated: k % 2 === 1,
        positionInitialMargin: str(c.price * 0.05),
      }),
    );
    return {
      body: {
        totalMarginBalance: "12500.50",
        totalWalletBalance: "12000",
        totalPositionInitialMargin: "2000.00",
        maxWithdrawAmount: "8000.00",
        assets: [{ asset: "USDT", walletBalance: "12000", marginBalance: "12500.50" }],
        positions,
      },
    };
  }
  if (path === "/dapi/v1/account") {
    return {
      body: {
        assets: [
          {
            asset: "BTC",
            marginBalance: "0.25",
            maxWithdrawAmount: "0.125",
            positionInitialMargin: "0.0625",
          },
        ],
        positions: [
          {
            symbol: "BTCUSD_PERP",
            positionAmt: "10",
            entryPrice: "58000",
            unrealizedProfit: "0.0125",
            leverage: "20",
            notional: "0.25",
            isolated: false,
            positionInitialMargin: "0.0625",
          },
        ],
      },
    };
  }
  return null;
}

const okxOk = (data) => ({ body: { code: "0", msg: "", data } });

function okx(u, path, seed) {
  const n = COUNTS.okx;
  if (path === "/api/v5/account/balance") {
    const details = pick(u.catalogue, n.trading, `okx:trade:${seed}`, { majors: 5 }).map((c, k) => {
      const amt = amountOf(`o:t:${seed}:${k}`, c);
      return {
        ccy: upper(c),
        eq: str(amt),
        cashBal: str(amt),
        eqUsd: str(amt * c.price),
        frozenBal: "0",
        availBal: str(amt),
        availEq: str(amt),
        upl: "0",
        uTime: "1700000000000",
      };
    });
    return okxOk([{ totalEq: "0", uTime: "1700000000000", details }]);
  }
  if (path === "/api/v5/asset/balances") {
    return okxOk(
      pick(u.catalogue, n.funding, `okx:fund:${seed}`).map((c, k) => ({
        ccy: upper(c),
        bal: str(amountOf(`o:f:${seed}:${k}`, c)),
        availBal: "0",
        frozenBal: "0",
      })),
    );
  }
  if (path === "/api/v5/finance/savings/balance") {
    return okxOk(
      pick(u.catalogue, n.savings, `okx:save:${seed}`).map((c, k) => ({
        ccy: upper(c),
        amt: str(amountOf(`o:s:${seed}:${k}`, c)),
        rate: "0.03",
        earnings: "0",
      })),
    );
  }
  if (path === "/api/v5/finance/staking-defi/orders-active") {
    return okxOk(
      pick(u.catalogue, n.staking, `okx:stake:${seed}`).map((c, k) => ({
        ccy: upper(c),
        protocol: `OKX ${upper(c)} Staking`,
        apy: "0.04",
        investData: [{ ccy: upper(c), amt: str(amountOf(`o:k:${seed}:${k}`, c)) }],
      })),
    );
  }
  if (path === "/api/v5/asset/asset-valuation") {
    return okxOk([
      {
        totalBal: "42694",
        details: { classic: "0", earn: "12000", funding: "694", trading: "30000" },
      },
    ]);
  }
  if (path === "/api/v5/account/positions") {
    return okxOk(
      pick(u.catalogue.slice(0, 50), n.positions, `okx:pos:${seed}`).map((c) => ({
        instId: `${upper(c)}-USDT-SWAP`,
        pos: "1",
        upl: "3.2",
      })),
    );
  }
  return null;
}

const bybitOk = (result) => ({ body: { retCode: 0, retMsg: "OK", result } });

function bybit(u, path, q, seed) {
  const n = COUNTS.bybit;
  if (path === "/v5/account/wallet-balance") {
    const coin = pick(u.catalogue, n.unified, `bybit:uta:${seed}`, { majors: 5 }).map((c, k) => {
      const amt = amountOf(`y:u:${seed}:${k}`, c);
      return {
        coin: upper(c),
        walletBalance: str(amt),
        equity: str(amt),
        usdValue: str(amt * c.price),
        locked: "0",
        unrealisedPnl: "0",
        cumRealisedPnl: "0",
      };
    });
    return bybitOk({
      list: [{ accountType: "UNIFIED", totalEquity: "83500", totalPerpUPL: "0", coin }],
    });
  }
  if (path === "/v5/asset/transfer/query-account-coins-balance") {
    return bybitOk({
      memberId: "1",
      accountType: "FUND",
      balance: pick(u.catalogue, n.funding, `bybit:fund:${seed}`).map((c, k) => ({
        coin: upper(c),
        walletBalance: str(amountOf(`y:f:${seed}:${k}`, c)),
        transferBalance: "0",
      })),
    });
  }
  if (path === "/v5/earn/position") {
    const category = q.get("category") ?? "";
    return bybitOk({
      list: pick(u.catalogue, n.earnPerCategory, `bybit:earn:${category}:${seed}`).map((c, k) => ({
        coin: upper(c),
        amount: str(amountOf(`y:e:${category}:${seed}:${k}`, c)),
        productId: `${k}`,
        totalPnl: "0",
      })),
    });
  }
  return null;
}

// ---------------------------------------------------------------- on-chain
function rabbyToken(chain, c, amount, isNative) {
  const id = isNative ? chain.slug : c.platforms[chain.platform];
  return {
    id,
    chain: chain.slug,
    name: c.name,
    symbol: upper(c),
    display_symbol: null,
    optimized_symbol: upper(c),
    decimals: 18,
    logo_url: `https://static.debank.example/token/${id}.png`,
    protocol_id: "",
    price: c.price,
    price_24h_change: c.change24h / 100,
    credit_score: 1_000_000,
    total_supply: 1e9,
    is_verified: true,
    is_core: true,
    is_wallet: true,
    is_scam: false,
    is_suspicious: false,
    time_at: 1_600_000_000,
    amount,
    raw_amount: amount * 1e18,
    raw_amount_hex_str: "0x0",
    raw_amount_str: "0",
  };
}

function rabby(u, path, q) {
  if (path === "/v1/chain/list") {
    return {
      body: RABBY_CHAINS.map((ch) => ({
        id: ch.slug,
        community_id: ch.chainId,
        name: ch.platform,
        native_token_id: ch.slug,
        logo_url: `https://static.debank.example/chain/${ch.slug}.png`,
        wrapped_token_id: "0x0",
        is_support_history: true,
      })),
    };
  }
  const address = (q.get("id") ?? "").toLowerCase();
  if (path === "/v1/user/total_balance") return { body: { total_usd_value: 1, chain_list: [] } };
  if (path === "/v1/user/cache_token_list") {
    const out = [];
    const perChain = Math.floor(COUNTS.rabby.tokens / RABBY_CHAINS.length);
    for (const ch of RABBY_CHAINS) {
      const eth = u.byId.get(ch.native);
      out.push(rabbyToken(ch, eth, amountOf(`r:n:${address}:${ch.slug}`, eth), true));
      const held = pick(u.chainPools.get(ch.slug), perChain - 1, `rabby:${address}:${ch.slug}`);
      for (const [k, c] of held.entries()) {
        out.push(rabbyToken(ch, c, amountOf(`r:t:${address}:${ch.slug}:${k}`, c), false));
      }
    }
    return { body: out };
  }
  if (path === "/v1/user/complex_protocol_list") {
    const ch = RABBY_CHAINS[0];
    const pool = u.chainPools.get(ch.slug);
    return {
      body: Array.from({ length: COUNTS.rabby.protocols }, (_, p) => ({
        id: `perf-protocol-${p}`,
        chain: ch.slug,
        name: `Perf Protocol ${p}`,
        site_url: "https://protocol.example",
        logo_url: `https://static.debank.example/project/${p}.png`,
        has_supported_portfolio: true,
        tvl: 1e9,
        portfolio_item_list: Array.from({ length: COUNTS.rabby.itemsPerProtocol }, (_, it) => {
          const [supply, reward, borrow] = pick(pool, 3, `rabby:proto:${address}:${p}:${it}`);
          const tok = (c, tag) =>
            rabbyToken(ch, c, amountOf(`r:p:${address}:${p}:${it}:${tag}`, c));
          return {
            stats: { asset_usd_value: 100, debt_usd_value: 10, net_usd_value: 90 },
            update_at: 1_785_279_687,
            name: it % 2 ? "Liquidity Pool" : "Lending",
            detail_types: ["lending"],
            detail: {
              supply_token_list: [tok(supply, "s")],
              reward_token_list: [tok(reward, "r")],
              borrow_token_list: [tok(borrow, "b")],
              health_rate: 5.04,
            },
            proxy_detail: {},
            pool: { id: `0x${hex(`pool:${p}:${it}`, 40)}`, chain: ch.slug, project_id: `p${p}` },
          };
        }),
      })),
    };
  }
  return null;
}

function coinstats(u, path, q) {
  if (path === "/wallet/blockchains") return { body: [{ connectionId: "solana", name: "Solana" }] };
  if (path !== "/wallet/balance") return null;
  const address = q.get("address") ?? "";
  const connectionId = q.get("connectionId") ?? "solana";
  const sol = u.byId.get("solana");
  const coins = [
    { c: sol, native: true },
    ...pick(u.solanaPool, COUNTS.coinstats.coins - 1, `cs:${address}`).map((c) => ({ c })),
  ];
  return {
    body: coins.map(({ c, native }, k) => ({
      coinId: native ? c.id : `${c.id}_solana`,
      amount: amountOf(`cs:${address}:${k}`, c),
      contractAddress: native ? null : c.platforms.solana,
      chain: "solana",
      name: c.name,
      symbol: upper(c),
      price: c.price,
      priceChange24h: c.change24h,
      imgUrl: `https://static.coinstats.example/${c.id}.png`,
      connectionId,
    })),
  };
}

function hyperliquid(u, body) {
  const address = String(body?.user ?? "");
  const positions = pick(
    u.catalogue.slice(0, 200),
    COUNTS.hyperliquid.positions,
    `hl:${address}`,
  ).map((c, k) => {
    const size = +(amountOf(`hl:${address}:${k}`, c) / 10).toPrecision(6);
    const signed = k % 3 ? size : -size;
    return {
      position: {
        coin: upper(c),
        szi: str(signed),
        entryPx: str(c.price),
        positionValue: str(Math.abs(signed) * c.price),
        unrealizedPnl: "1.25",
        returnOnEquity: "0.01",
        leverage: { value: 10, type: k % 2 ? "isolated" : "cross", rawUsd: "0.0" },
        liquidationPx: k % 4 ? str(c.price * (signed > 0 ? 0.7 : 1.3)) : null,
        marginUsed: str((Math.abs(signed) * c.price) / 10),
        maxLeverage: 50,
        cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
      },
      type: "oneWay",
    };
  });
  return {
    body: {
      marginSummary: {
        accountValue: "13109.48",
        totalMarginUsed: "4.97",
        totalNtlPos: "100.03",
        totalRawUsd: "13009.45",
      },
      crossMarginSummary: {
        accountValue: "13109.48",
        totalMarginUsed: "4.97",
        totalNtlPos: "100.03",
        totalRawUsd: "13009.45",
      },
      crossMaintenanceMarginUsed: "1.0",
      withdrawable: "13000.0",
      assetPositions: positions,
      time: Date.now(),
    },
  };
}

function blockbook(path) {
  const m = /^\/address\/([^/]+)$/.exec(path);
  if (!m) return null;
  const address = decodeURIComponent(m[1]);
  return {
    body: {
      page: 1,
      totalPages: 1,
      itemsOnPage: 1000,
      address,
      balance: String(10_000_000 + Math.floor(unit(`btc:${address}`) * 90_000_000)),
      totalReceived: "250000000",
      totalSent: "150000000",
      unconfirmedBalance: "0",
      unconfirmedTxs: 0,
      txs: 12,
    },
  };
}

// ---------------------------------------------------------------- server
/** 各上游的路径前缀。worker 那侧的 base URL = `<origin>/<前缀>`。 */
const UPSTREAMS = [
  "binance",
  "okx",
  "bybit",
  "rabby",
  "coinstats",
  "hyperliquid",
  "blockbook",
  "coingecko",
];

/** 签名 CEX 的 key 头:用它区分同一家的不同账户(数据集超过 8 个账户时会有第二个 binance)。 */
const KEY_HEADERS = ["x-mbx-apikey", "ok-access-key", "x-bapi-api-key"];

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function route(u, upstream, path, q, headers, body) {
  const seed = KEY_HEADERS.map((h) => headers[h]).find(Boolean) ?? "default";
  switch (upstream) {
    case "coingecko":
      return coingecko(u, path, q);
    case "binance":
      return binance(u, path, seed);
    case "okx":
      return okx(u, path, seed);
    case "bybit":
      return bybit(u, path, q, seed);
    case "rabby":
      return rabby(u, path, q);
    case "coinstats":
      return coinstats(u, path, q);
    case "hyperliquid":
      return path === "/info" ? hyperliquid(u, body) : null;
    case "blockbook":
      return blockbook(path);
    default:
      return null;
  }
}

const nowUs = () => Number(process.hrtime.bigint() / 1000n);

/**
 * 起假上游。返回 { origin, vars, stats(), hits, reset(), close() }:
 * - `vars`:要写进 worker `.dev.vars` 的覆盖(各家 base URL + 两把假 key)
 * - `hits`:收到的每一发 `{ atUs, upstream, path, status }`(时钟与 profiler 同一个单调钟)
 * - `stats()`:宇宙规模(写进 summary,数据集大小是结果的一部分)
 */
export async function startFakeUpstream({ port }) {
  const u = buildUniverse();
  const hits = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${port}`);
    const [, upstream, ...rest] = url.pathname.split("/");
    const path = `/${rest.join("/")}`;
    const body = await readBody(req);
    const hit = { atUs: nowUs(), upstream, path, status: 200 };
    hits.push(hit);
    const out = UPSTREAMS.includes(upstream)
      ? route(u, upstream, path, url.searchParams, req.headers, body)
      : null;
    if (!out) {
      hit.status = 404;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `fake-upstream: no route ${url.pathname}` }));
      return;
    }
    hit.status = out.status ?? 200;
    res.writeHead(hit.status, { "content-type": "application/json" });
    res.end(out.raw ?? JSON.stringify(out.body));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
  const origin = `http://${HOST}:${port}`;
  const base = (name) => `${origin}/${name}`;
  return {
    origin,
    vars: {
      BINANCE_API_BASE: base("binance"),
      BINANCE_FAPI_BASE: base("binance"),
      BINANCE_DAPI_BASE: base("binance"),
      OKX_API_BASE: base("okx"),
      BYBIT_API_BASE: base("bybit"),
      RABBY_API_BASE: base("rabby"),
      COINSTATS_API_BASE: base("coinstats"),
      HYPERLIQUID_API_BASE: base("hyperliquid"),
      BLOCKBOOK_API_BASE: base("blockbook"),
      COINGECKO_API_BASE: base("coingecko"),
      // 假 key:coinstats 没 key 直接判「缺凭据」不出网;CoinGecko 有 key 走 demo 档的闸
      // (每分钟 80 发)而不是无 key 那档(每分钟 10 发)—— 只影响 wall,不影响 CPU。
      COINSTATS_API_KEY: "perf-fake-coinstats-key",
      COINGECKO_API_KEY: "perf-fake-coingecko-key",
    },
    hits,
    stats: () => ({
      coins: u.coins.length,
      platformRows: u.platformRows,
      assetPlatforms: u.platforms.length,
      coinsListBytes: u.coinsList.length,
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
