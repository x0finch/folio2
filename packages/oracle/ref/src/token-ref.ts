// tokenRef —— 全系统唯一的代币命名法(ADR 0020,文法经 ADR 0021 收窄):`<namer>/<localName>`,恰好两段。
//
// 左段 `namer` = 「谁给的名字」(`evm:42161` / `bitcoin` / `binance` / `coingecko`)。
// 对本包**基本不透明** —— 不判断它是链、场馆还是数据源。唯一的例外是 localName 归一
// (见 `normalizeLocalName`),那里绕不开「这是不是 EVM」。
//
// 右段 `localName` 只有两种形状:
//   native      原生 gas 币(保留字)
//   <别的>      地址 或 不透明 id(合约地址 / CGK coin id / CEX symbol)
//
// 原先中间还有一段 `<assetNs>:`(`erc20:` / `token:`):那个词是各 producer 自己编的、全仓没人按它
// 分支,而 CoinGecko 只给「哪条链、哪个地址」—— 留着只会逼后面的映射表替每个 producer 猜。已去掉。
// 同时 `eip155:` 改 `evm:`:本文法早就不是 CAIP(真 CAIP 的比特币是 `bip122:…`),一半标准一半自编更别扭。
//
// **文法因此变得宽容**:任何「恰好两段、两段都非空」的串都是合法 tokenRef,本包无从分辨
// `evm:1/0xa0b8…` 与 `binance/USDC`(这正是收窄的代价 —— 平台改由 provider 直接报,见 #193)。
// 结构上读不懂的(没有斜杠 / 三段以上)仍判 `unknown`,`parseTokenRef` 永不 throw。

const SEP = "/";
// 保留字:`native` 只作完整 localName 出现。
const NATIVE = "native";
const EVM_NAMER_PREFIX = "evm:";

// 序列化形 —— **系统里流通的就是它**:Balance 带的、落库的、当 map key 的,都是这个串。
// 用别名而非裸 string,是为了在签名里说清"这里要的是一个 tokenRef,不是随便什么字符串"。
export type TokenRef = string;

// 拆开后的两支。造串给 `tokenRef.*` 构造函数即可,这个类型是给「解析 → 改一个字段 → 拼回去」用的。
export type TokenRefParts =
  | { kind: "native"; namer: string }
  | { kind: "local"; namer: string; localName: string };

// parse 的输出多一支 `unknown`:任何读不懂的串都得有个去处,故永不 throw。
export type ParsedTokenRef = TokenRefParts | { kind: "unknown"; raw: string };

/**
 * localName 的大小写是**按命名者**的:EVM 的 hex 地址大小写不敏感,小写成稳定的 key;
 * base58 / bech32 地址(Solana、Bitcoin、Tron)、CEX symbol、CGK coin id **大小写敏感,或已由
 * 生产者自行归一** —— 一律原样保留。这是本包唯一一处需要认命名者的地方。
 */
function normalizeLocalName(namer: string, localName: string): string {
  const s = localName.trim();
  return namer.startsWith(EVM_NAMER_PREFIX) ? s.toLowerCase() : s;
}

/**
 * 造 tokenRef 串。调用方给结构,`kind` 由这里定 —— 不手写。
 * 两个构造函数正对应两种形状:原生币走 `native`,别的(地址 / 不透明 id)一律走 `local`。
 */
export const tokenRef = {
  native: (namer: string): TokenRef => `${normalize(namer)}${SEP}${NATIVE}`,

  local: (namer: string, localName: string): TokenRef => {
    const n = normalize(namer);
    return `${n}${SEP}${normalizeLocalName(n, localName)}`;
  },
} as const;

export function formatTokenRef(ref: TokenRefParts): TokenRef {
  return ref.kind === "native"
    ? tokenRef.native(ref.namer)
    : tokenRef.local(ref.namer, ref.localName);
}

export function parseTokenRef(raw: TokenRef): ParsedTokenRef {
  const unknown = { kind: "unknown", raw } as const;
  // 恰好两段:三段(NFT 的 tokenId 之类)在本文法里没有意义,判 unknown 而非折进 localName。
  const segments = raw.trim().split(SEP);
  if (segments.length !== 2) return unknown;

  const namer = normalize(segments[0] ?? "");
  const localName = normalizeLocalName(namer, segments[1] ?? "");
  if (!namer || !localName) return unknown;

  if (localName.toLowerCase() === NATIVE) return { kind: "native", namer };
  return { kind: "local", namer, localName };
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}
