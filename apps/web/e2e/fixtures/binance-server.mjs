// 假 Binance —— e2e 专用。让「同步」这条链路在不联网的前提下真正跑通并出快照。
//
// 为什么需要它:9 个 connector 里只有 manual 不联网,而 manual 被排除在同步之外(ADR 0018)。
// 其余 8 个都要打外部 API,拿真 provider 跑 e2e 等于把第三方可用性绑进 CI,和这套 e2e 的反 flaky
// 原则(playwright.config.ts:「重试过了不算过」)直接冲突。
//
// 为什么可以只实现两个端点:一个 Binance 账户下的各 Wallet 是**尽力而为**的(ADR 0030)——
// 某个钱包拉不到不阻断其余,失败收进账户级 Note。所以现货 + 价表就够出快照了,
// 合约 / 资金 / 理财一律回空结构,账户照样同步成功。
//
// 不验签:provider 会带 HMAC,这里收下就回。e2e 要的是「链路通不通」,不是「签名对不对」
// (签名有单元测试)。
//
// 怎么被指过来的:`.dev.vars.test` 把 BINANCE_{API,FAPI,DAPI}_BASE 指到本进程。那是**生产也在用**
// 的 provider-creds 覆盖开关(#264,出口 IP 被拒时指向代理),不是为测试新开的分支。
//
// 谁起它:playwright.config.ts 的 webServer(`node e2e/fixtures/binance-server.mjs`)。因此它是**自己
// 的进程入口**,没有任何 import 指向它 —— knip.json 里给 apps/web 列了 `entry` 而不是塞 `ignore`:
// 前者说的是「这是个入口」(真话,而且它内部的死代码照样会被查),后者是「别看这个文件」。

import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_BINANCE_PORT ?? 3099);

// —— 可变状态,经 /__control 改 ——
// 为什么不用启动时的环境变量:一轮测试里**同一个进程要扮演两种上游**。加账户时要快(校验凭据别干等),
// 量「关标签页」那条时要慢(同步得慢到能在中途插进去)。
//
// 更要紧的是 spotBtc:「关掉标签页之后那一轮真的跑完了」这个断言,靠的是**余额在点同步之前被改过** ——
// 事后读到新数字,就只能是关标签之后才发生的那次抓取写进去的。启动时定死的常量给不了这个。
// hits 是**只增的收数计数**,给测试当护栏用:本地 `reuseExistingServer` 会复用一个已经开着的 dev
// server,而那个 server 可能是普通 `pnpm dev` 起的(没有 CLOUDFLARE_ENV=test)—— 它打的是真 Binance。
// 那种情况下失败信息会很糊(「binance auth failed」),看不出根因是环境没切。数一下收到几个请求,
// 一句话就能说清。测试可以 POST hits:0 归零。
const state = { delayMs: 0, spotBtc: "1.50000000", btcPrice: "60000.00", hits: 0 };
const NUMERIC_KEYS = new Set(["delayMs", "hits"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const routes = () => ({
  // 现货:一条 BTC 持仓 —— 快照里断言得到,数量可改。
  "/api/v3/account": { balances: [{ asset: "BTC", free: state.spotBtc, locked: "0.00000000" }] },
  // 价表:现货估值要它。
  "/api/v3/ticker/price": [
    { symbol: "BTCUSDT", price: state.btcPrice },
    { symbol: "ETHUSDT", price: "3000.00" },
  ],
  // 其余钱包回空 —— 结构合法即可,provider 解析出 0 行。
  "/fapi/v2/account": { totalWalletBalance: "0", assets: [], positions: [] },
  "/dapi/v1/account": { assets: [], positions: [] },
  "/sapi/v1/asset/get-funding-asset": [],
  "/sapi/v1/simple-earn/flexible/position": { rows: [], total: 0 },
  "/sapi/v1/simple-earn/locked/position": { rows: [], total: 0 },
});

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readJsonBody = async (req) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};

createServer(async (req, res) => {
  const path = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // Playwright 的 webServer 探这个判断起没起来。
  if (path === "/ping") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // 控制端点:GET 读当前状态,POST 改。只认已知键 —— 键名拼错要当场报错,
  // 不能静默无效(那会让一条测试看着在测慢同步,其实一直是 0 延迟)。
  if (path === "/__control") {
    if (req.method === "POST") {
      const patch = await readJsonBody(req);
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in state)) return json(res, 400, { error: `unknown control key: ${key}` });
        state[key] = NUMERIC_KEYS.has(key) ? Number(value) : String(value);
      }
    }
    return json(res, 200, state);
  }

  state.hits += 1;
  if (state.delayMs > 0) await sleep(state.delayMs);
  const body = routes()[path];
  if (body === undefined) {
    return json(res, 404, { code: -1121, msg: `fake-binance: no route ${path}` });
  }
  return json(res, 200, body);
}).listen(PORT, () => {
  console.log(`fake-binance listening on ${PORT}`);
});
