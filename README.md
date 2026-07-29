# Folio

自托管加密货币组合追踪器 —— 链上钱包、Bitcoin、CEX、永续 DEX、手动资产,汇成一个看板。

<!-- TODO:此处贴一张总览页截图 / GIF —— UI 仓库最值钱的一块。 -->

Folio 从你用到的每个来源**只读**拉取余额,经 canonical 代币层归一为 USD,呈现一个组合 —— 持仓、24h 涨跌、占比、净值曲线、单资产 drill-down,并可按你选的币种计价(法币或 BTC/ETH)。全程跑在你自己的 Cloudflare 账户上,数据不外流。

## 功能

- **数据源** —— EVM 链(Zerion)、Solana / Sui / Cosmos(CoinStats)、**Bitcoin**(地址 + xpub/ypub/zpub,经 Trezor Blockbook)、CEX(Binance、OKX)、永续 DEX(Hyperliquid),以及手动持仓。
- **统一定价** —— CoinGecko 市场价 + canonical 聚合(同一代币跨链/跨场馆并成一条持仓);逐资产单价按快照留存。
- **多币种** —— 约 10 种法币或 BTC/ETH 计价(USD 基准,展示层换算)。
- **分析** —— 占比、24h 涨跌、净值历史、单资产 drill-down。
- **只读且私密** —— 无私钥、不签名;每账户凭据 AES-GCM 加密落库;自托管。

## 技术栈

TanStack Start + Vite · Cloudflare Workers + D1(SQLite)+ Drizzle · better-auth · pnpm workspace 单仓 · TypeScript strict · Vitest · Biome。

## 快速开始

前置:Node、`pnpm@10`、一个 Cloudflare 账户(D1)。

```bash
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars   # 填入下方密钥
pnpm --filter @folio/web db:migrate:local          # 本地应用 D1 迁移
pnpm dev                                            # → http://localhost:3000
```

`apps/web/.dev.vars` 里的密钥:

- `SECRETS_KEY` —— `openssl rand -base64 32`(加密每账户凭据的 AES-GCM key)
- `BETTER_AUTH_SECRET`、`BETTER_AUTH_URL` —— 鉴权
- Provider key(可选,按源):`COINSTATS_API_KEY`(Solana/Sui/Cosmos)、`COINGECKO_API_KEY`(定价)、`ZERION_API_KEY`(EVM 备源)。**EVM 与 Bitcoin 都无需 key** —— EVM 默认走 Rabby、Bitcoin 走公共 Blockbook。

## 部署

Cloudflare Workers —— 见 **[apps/web/DEPLOY.md](apps/web/DEPLOY.md)**(用 `wrangler secret` 配密钥、`db:migrate:remote`,再 `pnpm --filter @folio/web deploy`)。

## 文档

- **架构总览** —— [docs/architecture/00-overview.md](docs/architecture/00-overview.md)
- **决策记录(ADR)** —— [docs/adr/](docs/adr/)
- **路线图** —— [docs/roadmap.md](docs/roadmap.md)
- **工程约定** —— [CLAUDE.md](CLAUDE.md) · [CODING.md](CODING.md)

## 状态

M1–M6 已交付(地基 → 链上 → CEX → 永续 → 打磨);已加入 Bitcoin(地址 + xpub)。前向工作见[路线图](docs/roadmap.md)。设计上只读追踪 —— Folio 绝不持有私钥。

## 许可

_暂无 license —— 公开前建议补一个(如 MIT 或 AGPL-3.0);无 license 时默认版权保留所有权利。_
