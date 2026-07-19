import type { ConnectorId } from "@folio/connectors";
import {
  Atom,
  Bitcoin,
  CandlestickChart,
  Droplet,
  Landmark,
  type LucideIcon,
  SquarePen,
  Wallet,
  Zap,
} from "lucide-react";

// 每个 Connector 在「添加账户」网格里的图标(lucide outline,仅语义;无品牌 logo 资产、绝不用品牌色 —— 只随
// currentColor 走 design token)。`Record<ConnectorId, …>` 编译期即穷尽:新增 connector 不补一项直接 tsc 报错;
// 运行时另有覆盖测(tests/connector-icons.test.ts)守 CONNECTOR_OPTIONS 与本表不漂移。
export const CONNECTOR_ICON: Record<ConnectorId, LucideIcon> = {
  manual: SquarePen,
  evm: Wallet,
  bitcoin: Bitcoin,
  solana: Zap,
  sui: Droplet,
  cosmos: Atom,
  binance: Landmark,
  okx: Landmark,
  hyperliquid: CandlestickChart,
};
