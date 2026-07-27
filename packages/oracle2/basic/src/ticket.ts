import { parseTokenRef, type TokenRef } from "@folio/oracle-ref";

// **票**(ticket)—— 一条 tokenRef 交给浏览器时的形状:base64url 编过的不透明串。
//
// 为什么不直接把 ref 发过去。选币下拉里的每一项都得带上「用户点的是哪个币」,而那个答案
// 今天长成 `coingecko/usd-coin`。原样发出去,前端就多知道了两件不该它管的事:当前上游是谁,
// 以及它的 id 长什么样 —— 于是迟早会有人在组件里 `split("/")`,换源那天就地爆炸。
// 编一层之后前端只能**原样搬运**:点中什么就把那串还回来,解释权在服务端。
//
// **它不是加密、不是签名、也不是权限。** base64url 谁都能解开,它挡的是「顺手用一下」,
// 不是恶意。收到票之后照样要过 mint 那条正常的路(mint 只认文法合规的 ref),
// 而 mint 本身就是 per-user 的 —— 拿别人的票也只会在自己库里建自己的行。
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

  // 解不开 / 解出来不是一条合规 ref → undefined。**调用方必须处理这一档** ——
  // 票是从网络上来的,当不合规的输入对待,而不是当自己刚编出来的东西。
  decode(ticket: string): TokenRef | undefined {
    if (!ticket || !B64URL.test(ticket)) return undefined;
    let raw: string;
    try {
      raw = fromB64Url(ticket);
    } catch {
      return undefined;
    }
    return parseTokenRef(raw).kind === "unknown" ? undefined : (raw as TokenRef);
  },
};
