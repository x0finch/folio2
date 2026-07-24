// tokenRef —— 全系统唯一的代币命名法(ADR 0020):`<namer>/<localName>`,第一个 `/` 切分。
//
// 左段 `namer` = 「谁给的名字」(`eip155:42161` / `bitcoin` / `binance` / `coingecko`)。
// 对本包**不透明** —— 不判断它是链、场馆还是数据源:右段自己说明了自己,没人需要这个分类。
//
// 右段 `localName` 三种形状:
//   native                原生 gas 币(保留字,只作字面量出现)
//   <assetNs>:<address>   合约币(`erc20:0x…` / `token:…`)
//   <id>                  不透明 id(CGK coin id / CEX symbol)
//
// 归一:namer / assetNs / address 小写(都是寻址成分);不透明 id **一个字不动** ——
// 归一是生产者的事(币安 connector 自己保证 symbol 大写),本包只负责别把它改坏。
//
// 只认规范形。旧文法的串(`chain:` 前缀 / `native:<sym>` / 无斜杠的 `coingecko:<id>`)
// 一律判 `unknown` —— 读旧串是迁移那一片的事,不在本包。

const SEP = "/";
// 保留字:`native` 只作完整 localName 出现,不接冒号 —— 故 `native:<x>` 不是合法合约形。
const NATIVE = "native";

export type TokenRef =
  | { kind: "native"; namer: string }
  | { kind: "contract"; namer: string; assetNs: string; address: string }
  | { kind: "opaque"; namer: string; id: string };

// parse 的输出多一支 `unknown`:任何读不懂的串都得有个去处,故永不 throw。
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
  if (slash < 0) return unknown;

  const namer = normalize(trimmed.slice(0, slash));
  const localName = trimmed.slice(slash + SEP.length).trim();
  if (!namer || !localName) return unknown;

  const colon = localName.indexOf(":");
  if (colon < 0) {
    if (normalize(localName) === NATIVE) return { kind: "native", namer };
    return { kind: "opaque", namer, id: localName };
  }

  const assetNs = normalize(localName.slice(0, colon));
  const address = normalize(localName.slice(colon + 1));
  if (!assetNs || !address || assetNs === NATIVE) return unknown;
  return { kind: "contract", namer, assetNs, address };
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}
