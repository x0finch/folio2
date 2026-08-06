// 假 Binance —— e2e 专用。让「同步」这条链路在不联网的前提下能真正跑通并出快照。
//
// 为什么可以只实现两个端点:一个 Binance 账户下的各 Wallet 是**尽力而为**的(见 CONTEXT.md 的
// Wallet 条目)—— 某个钱包拉不到不阻断其余,失败收进账户级 Note。所以现货 + 价表够了,
// 合约/资金/理财一律回空结构,账户照样同步成功。
//
// 不验签:provider 会带 HMAC,这里收下就回。e2e 要的是「链路通不通」,不是「签名对不对」
// (签名有单元测试)。
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_BINANCE_PORT ?? 3099);
// 每个请求人为拖一会儿 —— 「中途关标签页」那条测试要同步慢到能插进去。
const DELAY_MS = Number(process.env.FAKE_BINANCE_DELAY_MS ?? 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const routes = {
  // 现货:一条 BTC 持仓,快照里能断言得到。
  "/api/v3/account": { balances: [{ asset: "BTC", free: "1.50000000", locked: "0.00000000" }] },
  // 价表:现货估值要它。
  "/api/v3/ticker/price": [
    { symbol: "BTCUSDT", price: "60000.00" },
    { symbol: "ETHUSDT", price: "3000.00" },
  ],
  // 其余钱包回空 —— 结构合法即可,provider 解析出 0 行。
  "/fapi/v2/account": { totalWalletBalance: "0", assets: [], positions: [] },
  "/dapi/v1/account": { assets: [], positions: [] },
  "/sapi/v1/asset/get-funding-asset": [],
  "/sapi/v1/simple-earn/flexible/position": { rows: [], total: 0 },
  "/sapi/v1/simple-earn/locked/position": { rows: [], total: 0 },
};

createServer(async (req, res) => {
  const path = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (path === "/ping") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (DELAY_MS > 0) await sleep(DELAY_MS);
  const body = routes[path];
  if (body === undefined) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: -1121, msg: `fake-binance: no route ${path}` }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}).listen(PORT, () => {
  console.log(`fake-binance listening on ${PORT} (delay ${DELAY_MS}ms)`);
});
