// tokenRef —— 全系统唯一的代币命名法(ADR 0020):`<namer>/<localName>`,第一个 `/` 切分。
//
// 左段 `namer` = 「谁给的名字」(`eip155:42161` / `bitcoin` / `binance` / `coingecko`)。
// 对本包**不透明** —— 不判断它是链、场馆还是数据源:右段自己说明了自己,没人需要这个分类。
//
// 右段 `localName` 三种形状:
//   native                原生 gas 币
//   <assetNs>:<address>   合约币(`erc20:0x…` / `token:…`)
//   <id>                  不透明 id(CGK coin id / CEX symbol)
//
// 归一:namer / assetNs / address 小写(都是寻址成分);不透明 id **一个字不动** ——
// 归一是生产者的事(币安 connector 自己保证 symbol 大写),本包只负责别把它改坏。

const SEP = "/";
const NATIVE = "native";
// 旧文法的两处遗留形状,parse 容旧(永久要求:历史串必须永远读得出来)。
const LEGACY_CHAIN_PREFIX = "chain:";
const LEGACY_SLASHLESS_NAMER = "coingecko";

export type TokenRef =
  | { kind: "native"; namer: string }
  | { kind: "contract"; namer: string; assetNs: string; address: string }
  | { kind: "opaque"; namer: string; id: string };

// parse 的输出多一支 `unknown`:持久化的历史串必须永远读得出来,哪怕语义已废弃 → 永不 throw。
export type ParsedTokenRef = TokenRef | { kind: "unknown"; raw: string };

export function formatTokenRef(ref: TokenRef): string {
  const namer = normalize(ref.namer);
  switch (ref.kind) {
    case "native":
      return `${namer}${SEP}${NATIVE}`;
    case "contract":
      return `${namer}${SEP}${normalize(ref.assetNs)}:${normalize(ref.address)}`;
    case "opaque":
      return `${namer}${SEP}${ref.id.trim()}`;
  }
}

export function parseTokenRef(raw: string): ParsedTokenRef {
  const unknown = { kind: "unknown", raw } as const;
  const trimmed = raw.trim();
  if (!trimmed) return unknown;

  const slash = trimmed.indexOf(SEP);
  // 容旧:旧 refKey 文法 `coingecko:<id>` 没有斜杠,是唯一的无斜杠合法形。
  if (slash < 0) {
    const colon = trimmed.indexOf(":");
    const namer = normalize(trimmed.slice(0, colon < 0 ? 0 : colon));
    const id = trimmed.slice(colon + 1).trim();
    if (namer !== LEGACY_SLASHLESS_NAMER || !id) return unknown;
    return { kind: "opaque", namer, id };
  }

  // 容旧:旧的链命名者带 `chain:` 前缀,短形去掉它(`eip155:<id>` 保留,它不是前缀而是名字本身)。
  const namer = stripPrefix(normalize(trimmed.slice(0, slash)), LEGACY_CHAIN_PREFIX);
  const localName = trimmed.slice(slash + SEP.length).trim();
  if (!namer || !localName) return unknown;

  const colon = localName.indexOf(":");
  if (colon < 0) {
    // 容旧:旧 native 串尾巴挂着 symbol(`native:btc`),从来没被读出来过 → 下面一并丢弃。
    if (normalize(localName) === NATIVE) return { kind: "native", namer };
    return { kind: "opaque", namer, id: localName };
  }

  const assetNs = normalize(localName.slice(0, colon));
  const address = normalize(localName.slice(colon + 1));
  if (!assetNs || !address) return unknown;
  if (assetNs === NATIVE) return { kind: "native", namer };
  return { kind: "contract", namer, assetNs, address };
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function stripPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}
