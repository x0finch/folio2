// 选币下拉里的一项 —— 选币 server fn 的**出参形状**,组件与 server fn 共用。
//
// `ticket` 是这一项的身份,一串 base64url(见 `@folio/oracle` 的 `tokenTicket`)。
// **前端原样搬运,不解释、不拆、不比较字面含义** —— 点中之后把它原样交回服务端,
// 服务端解回一条 tokenRef 再去认币。当前上游是谁、它的 id 长什么样,前端不需要知道,
// 知道了反而会在组件里长出 `split("/")` 这种东西,换源那天就地爆炸。
//
// 可以做的只有两件:当 React key 用,以及判两项是不是同一个币(串相等)。
//
// `rank` / `price` / `change24h` / `asOf` 都是**展示用的市场数据**,可缺:
//   · `rank` —— 市值排名,给下拉的消歧徽标(缺 → 不显示徽标)。默认列来自 warm markets、
//     搜索来自 /search,两者不可比但都只当「有没有 / 大概多前」用。
//   · `price` / `change24h` / `asOf` —— 现价 / 24h 涨跌 / 该价的时刻。搜索来的行没有价
//     (asOf 也无),由下拉的 SWR 刷价按需补上(见 token-search.ts 的 staleTickets)。
export interface TokenOption {
  ticket: string;
  symbol: string;
  name: string;
  logo?: string;
  rank?: number;
  price?: number;
  change24h?: number;
  asOf?: number;
}
