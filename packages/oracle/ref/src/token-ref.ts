// tokenRef —— 全系统唯一的代币命名法(ADR 0020,文法经两轮修订):`<namer>/<localName>`,恰好两段。
//
// 左段 `namer` = 「谁给的名字」(`evm:42161` / `bitcoin` / `binance` / `coingecko`)。
// 对本包**基本不透明** —— 不判断它是链、场馆还是数据源。唯一的例外是合约地址的大小写归一
// (见 `normalizeAddress`),那里绕不开「这是不是 EVM」。
//
// 右段 `localName` 三种形状:
//   native                原生 gas 币(保留字)
//   contract:<地址>       某条链上的合约地址
//   <别的>                不透明 id(上游 coin id / 场馆代号 / 用户手记的 symbol)
//
// **`contract:` 是文法自己的常量,不是 producer 自选的词。** 第二轮曾把这一段整个删掉(理由:
// 那时的 `<assetNs>:` 由各 producer 自己编 —— zerion 写 `erc20`、coinstats 写 `token` —— 且全仓
// 没人按它分支)。前半个理由仍然成立,所以回来的只有一个固定值;后半个被证伪 —— 认币的 symbol
// 那一档**必须**知道右半边是不是合约地址:合约的 symbol 字段是部署者随手填的,拿它当身份线索
// 会把一个 symbol 写着 `USDC` 的山寨合约并进真 USDC(ADR 0020 第三轮)。
//
// 也刻意**不叫 `erc20:`** —— Solana 上那叫 SPL、Sui 上叫 Coin,写 `erc20` 就是又替 producer 编词。
//
// 造串走 `tokenRef.*` 构造函数,调用方不手写 `kind`;`parseTokenRef` / `formatTokenRef` 管
// 「拆开看 / 改一个字段再拼回去」的往返。只认规范形:读不懂的一律判 `unknown`,永不 throw。

const SEP = "/";
// 保留字:`native` 只作完整 localName 出现。
const NATIVE = "native";
// 唯一合法的 localName 标记。别的词(含旧文法的 `erc20:` / `token:`)一律判 unknown。
const CONTRACT = "contract:";
const EVM_NAMER_PREFIX = "evm:";

// 序列化形 —— **系统里流通的就是它**:Balance 带的、落库的、当 map key 的,都是这个串。
// 用别名而非裸 string,是为了在签名里说清"这里要的是一个 tokenRef,不是随便什么字符串"。
export type TokenRef = string;

// 拆开后的三支。造串给 `tokenRef.*` 构造函数即可,这个类型是给「解析 → 改一个字段 → 拼回去」用的。
export type TokenRefParts =
  | { kind: "native"; namer: string }
  | { kind: "contract"; namer: string; address: string }
  | { kind: "opaque"; namer: string; id: string };

// 两段形:只有左右两段,不表态右段是什么。按两列存的表读写的就是这个形状。
export interface TokenRefSegments {
  namer: string;
  localName: string;
}

// parse 的输出:三支各自多带一个 `localName`(右段的**规范形**),外加一支 `unknown` ——
// 任何读不懂的串都得有个去处,故永不 throw。
//
// 为什么 parse 要给 localName 而 `TokenRefParts` 不带:按两列存 tokenRef 的表(`token_refs`,
// ADR 0022)要的正是这两段,而 parse 本来就在半路上算出过它。不给的话调用方只能 parse → format
// → 再 split 一次,绕一圈把已经有的东西捡回来。反过来 `TokenRefParts` 是**造串的入参**
// (`formatTokenRef`),那里给 localName 就是让同一件事有两个可以互相矛盾的写法。
export type ParsedTokenRef =
  | (TokenRefParts & { localName: string })
  | { kind: "unknown"; raw: string };

/**
 * 合约地址的大小写是**按链**的:EVM 的 hex 大小写不敏感,小写成稳定的 key;
 * base58 / bech32 地址(Solana、Bitcoin、Tron)**大小写敏感**,小写下去就是个不存在的地址
 * —— 原样保留。这是本包唯一一处需要认命名者的地方。
 */
function normalizeAddress(namer: string, address: string): string {
  const addr = address.trim();
  return namer.startsWith(EVM_NAMER_PREFIX) ? addr.toLowerCase() : addr;
}

/**
 * 造 tokenRef 串。调用方给结构,`kind` 由这里定 —— 不手写。
 * 三个构造函数正对应三种形状,**选哪个就是在声明这条 ref 的证据强度**:
 * `contract` 的 symbol 不可信(部署者填的),`opaque` 的可信(场馆上架代号 / 上游 id / 用户手选)。
 */
export const tokenRef = {
  native: (namer: string): TokenRef => `${normalize(namer)}${SEP}${NATIVE}`,

  contract: (namer: string, address: string): TokenRef => {
    const n = normalize(namer);
    return `${n}${SEP}${CONTRACT}${normalizeAddress(n, address)}`;
  },

  // 不透明 id 一个字不动 —— 归一是生产者的事(币安 connector 自己保证 symbol 大写)。
  opaque: (namer: string, id: string): TokenRef => `${normalize(namer)}${SEP}${id.trim()}`,
} as const;

/**
 * 造串,收**两种描述方式**:
 *   语义形 `{kind, namer, address|id}` —— 知道这是个什么东西时用(改一个字段再拼回去)。
 *   两段形 `{namer, localName}` —— 只有两段、不关心右段是什么时用。
 *
 * 后者是给**按两列存 tokenRef 的表**的(`token_refs`:拆开存是为了能按 namer 单独筛 /
 * 反查某个 Token 在某命名者下的叫法,见 ADR 0022)。存储层因此**不必知道右段的文法** ——
 * 不用 switch `native` / `contract:`,也不用知道分隔符是斜杠;拆的那一半直接读
 * `parseTokenRef` 的 `namer` / `localName`(读不懂 → `kind === "unknown"`,那种串不进表)。
 *
 * 两条路对 parse 的输出**结果相同**(它同时带 `kind` 和 `localName`)—— round-trip 用例钉着这件事。
 * 两段形**不做文法校验**:表里存的本来就只有规范形,那是写入侧的责任(见 `tokenRef.*` 构造函数)。
 */
export function formatTokenRef(ref: TokenRefParts | TokenRefSegments): TokenRef {
  // `kind` 就是「说话人表没表态右段是什么」的判据:语义形有,两段形没有。
  const isSemantic = "kind" in ref;
  if (!isSemantic) return `${normalize(ref.namer)}${SEP}${ref.localName.trim()}`;
  switch (ref.kind) {
    case "native":
      return tokenRef.native(ref.namer);
    case "contract":
      return tokenRef.contract(ref.namer, ref.address);
    case "opaque":
      return tokenRef.opaque(ref.namer, ref.id);
  }
}

export function parseTokenRef(raw: TokenRef): ParsedTokenRef {
  const unknown = { kind: "unknown", raw } as const;
  // 恰好两段:三段(NFT 的 tokenId 之类)在本文法里没有意义,判 unknown 而非折进 localName。
  const segments = raw.trim().split(SEP);
  if (segments.length !== 2) return unknown;

  const namer = normalize(segments[0] ?? "");
  const localName = (segments[1] ?? "").trim();
  if (!namer || !localName) return unknown;

  // 每一支的 localName 都给**规范形**(`native` 小写、EVM 地址小写),不是原样回抛 ——
  // 它会被直接写进表,而表里必须只有规范形,否则同一个地址大小写不同就是两行。
  if (localName.toLowerCase() === NATIVE) return { kind: "native", namer, localName: NATIVE };

  if (localName.toLowerCase().startsWith(CONTRACT)) {
    const address = normalizeAddress(namer, localName.slice(CONTRACT.length));
    return address ? { kind: "contract", namer, address, localName: CONTRACT + address } : unknown;
  }

  // 带冒号但不是 `contract:` —— 旧文法(`erc20:` / `token:` / `native:`)或哪个 producer 自己
  // 编的词。不容旧、也不容自创:判 unknown,而不是静默读成一个 id 里带冒号的不透明币。
  if (localName.includes(":")) return unknown;

  return { kind: "opaque", namer, id: localName, localName };
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}
