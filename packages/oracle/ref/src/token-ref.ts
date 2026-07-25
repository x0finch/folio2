// tokenRef —— 全系统唯一的代币命名法(ADR 0020):`<namer>/<localName>`,恰好两段。
//
// 左段 `namer` = 「谁给的名字」(`eip155:42161` / `bitcoin` / `binance` / `coingecko`)。
// 对本包**基本不透明** —— 不判断它是链、场馆还是数据源:右段自己说明了自己。唯一的例外是
// 地址归一(见 `normalizeAddress`),那里绕不开「这是不是 EVM」。
//
// 右段 `localName` 三种形状:
//   native                原生 gas 币(保留字,只作字面量出现)
//   <assetNs>:<address>   合约币(`erc20:0x…` / `token:…`)
//   <id>                  不透明 id(CGK coin id / CEX symbol)
//
// 造串走 `tokenRef.*` 构造函数,调用方不手写 `kind`;`parseTokenRef` / `formatTokenRef` 管
// 「拆开看 / 改一个字段再拼回去」的往返。
//
// 只认规范形。旧文法的串(`chain:` 前缀 / `native:<sym>` / 无斜杠的 `coingecko:<id>`)
// 一律判 `unknown` —— 读旧串是迁移那一片的事,不在本包。

const SEP = "/";
// 保留字:`native` 只作完整 localName 出现,不接冒号 —— 故 `native:<x>` 不是合法合约形。
const NATIVE = "native";
const EVM_NAMER_PREFIX = "eip155:";

export type TokenRef =
  | { kind: "native"; namer: string }
  | { kind: "contract"; namer: string; assetNs: string; address: string }
  | { kind: "opaque"; namer: string; id: string };

// parse 的输出多一支 `unknown`:任何读不懂的串都得有个去处,故永不 throw。
export type ParsedTokenRef = TokenRef | { kind: "unknown"; raw: string };

/**
 * 地址大小写是**按链**的:EVM 的 hex 大小写不敏感,小写成稳定的 key;
 * base58 / bech32 地址(Solana、Bitcoin、Tron)**大小写敏感**,小写下去就是个不存在的地址
 * —— 原样保留。这是本包唯一一处需要认命名者的地方。
 */
export function normalizeAddress(namer: string, address: string): string {
  const addr = address.trim();
  return namer.startsWith(EVM_NAMER_PREFIX) ? addr.toLowerCase() : addr;
}

/**
 * 造 tokenRef 串。调用方给结构,`kind` 由这里定 —— 不手写。
 * `assetNs` 不给默认值:各链的标准由生产者说了算(zerion 给 `erc20`、coinstats 给 `token`),
 * 本包不按命名者去猜。
 */
export const tokenRef = {
  native: (namer: string): string => `${normalize(namer)}${SEP}${NATIVE}`,

  contract: (namer: string, assetNs: string, address: string): string => {
    const n = normalize(namer);
    return `${n}${SEP}${normalize(assetNs)}:${normalizeAddress(n, address)}`;
  },

  // 不透明 id 一个字不动 —— 归一是生产者的事(币安 connector 自己保证 symbol 大写)。
  opaque: (namer: string, id: string): string => `${normalize(namer)}${SEP}${id.trim()}`,
} as const;

export function formatTokenRef(ref: TokenRef): string {
  switch (ref.kind) {
    case "native":
      return tokenRef.native(ref.namer);
    case "contract":
      return tokenRef.contract(ref.namer, ref.assetNs, ref.address);
    case "opaque":
      return tokenRef.opaque(ref.namer, ref.id);
  }
}

export function parseTokenRef(raw: string): ParsedTokenRef {
  const unknown = { kind: "unknown", raw } as const;
  // 恰好两段:三段(NFT 的 tokenId 之类)在本文法里没有意义,判 unknown 而非折进地址。
  const segments = raw.trim().split(SEP);
  if (segments.length !== 2) return unknown;

  const namer = normalize(segments[0] ?? "");
  const localName = (segments[1] ?? "").trim();
  if (!namer || !localName) return unknown;

  const colon = localName.indexOf(":");
  if (colon < 0) {
    if (normalize(localName) === NATIVE) return { kind: "native", namer };
    return { kind: "opaque", namer, id: localName };
  }

  const assetNs = normalize(localName.slice(0, colon));
  const address = normalizeAddress(namer, localName.slice(colon + 1));
  if (!assetNs || !address || assetNs === NATIVE) return unknown;
  return { kind: "contract", namer, assetNs, address };
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}
