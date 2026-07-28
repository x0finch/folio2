import { formatTokenRef, normalizeNamer, parseTokenRef, type TokenRef } from "@folio/oracle-ref";

// **票**(ticket)—— 一条 tokenRef 交给浏览器时的形状:base64url 编过的不透明串。
//
// 为什么不直接把 ref 发过去。选币下拉里的每一项都得带上「用户点的是哪个币」,而那个答案
// 今天长成 `coingecko/usd-coin`。原样发出去,前端就多知道了两件不该它管的事:当前上游是谁,
// 以及它的 id 长什么样 —— 于是迟早会有人在组件里 `split("/")`,换源那天就地爆炸。
// 编一层之后前端只能**原样搬运**:点中什么就把那串还回来,解释权在服务端。
//
// **它不是加密、不是签名、也不是权限。** base64url 谁都能解开、也谁都能自己编一张。
// 所以「这是我们发出去的那张票」只能靠**内容自证**:它的命名者必须就是当前那位 ——
// 这就是 `decode` 为什么收 `namer`,而且是必填参数(可选的话总有一天有人忘了传)。
//
// 缺了这一句会怎样:手编一张 `<随便什么>/issued:<随便什么>` 塞进手记的表单,mint 那边
// 「命名者不匹配 → 映射表查不到 → `hasTrustedSymbol(issued)` 为真 → 走 symbol 那一档」,
// 于是**用户手敲的 symbol 又变成了可信线索** —— #223 刚收紧掉的正是这件事。
// `issued` 的含义是「命名者为这个标识负责」,而在这道门上没人核对过那个命名者我们认不认识。
//
// **只比命名者就够了**,不必再挑形状:命名者对上之后,四种形状在 mint 里各有各的正常去处
// (`contract` / `custom` 被 symbol 闸挡住,`issued` 走它该走的锚那一档)。
//
// 风险量级要说清:能编这张票的只有账号本人(server fn 有同源 CSRF 闸,别的站点构造不出来),
// 而他在选币下拉里点一下就能合法拿到同样结果。所以这不是安全洞 —— 补它的理由是
// **服务端的保证不该依赖客户端守规矩**,而这一句的成本就是一次比较。
//
// 收到票之后照样要过 mint 那条正常的路,而 mint 本身就是 per-user 的 ——
// 拿别人的票也只会在自己库里建自己的行。
//
// 用 base64url 而不是裸 base64:票要进 URL 查询串(选币取价那个 GET),`+` / `/` 得转义。

const B64URL = /^[A-Za-z0-9_-]+$/;

const toB64Url = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64Url = (s: string): string => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

export const tokenTicket = {
  encode(ref: TokenRef): string {
    return toB64Url(ref);
  },

  // 解不开 / 不是合规 ref / 命名者不是 `namer` → 一律 undefined。**调用方必须处理这一档** ——
  // 票是从网络上来的,当不合规的输入对待,而不是当自己刚编出来的东西。
  //
  // 回的是**规范形**(不是原样回抛):这条 ref 会被直接拿去 mint、落进 `token_refs`,
  // 而表里只能有规范形 —— 否则 `CoinGecko/ISSUED:x` 和 `coingecko/issued:x` 就是两行。
  decode(ticket: string, namer: string): TokenRef | undefined {
    if (!ticket || !B64URL.test(ticket)) return undefined;
    let raw: string;
    try {
      raw = fromB64Url(ticket);
    } catch {
      return undefined;
    }
    const parsed = parseTokenRef(raw);
    if (parsed.kind === "unknown") return undefined;
    // 命名者按规范形比 —— 两边都过 parse/normalize,不拿原串比大小写。
    if (parsed.namer !== normalizeNamer(namer)) return undefined;
    return formatTokenRef(parsed);
  },
};
