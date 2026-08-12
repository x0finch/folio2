import { accountStackItems } from "../lib/account-stack-items";
import type { OverviewBalance } from "../lib/account-view";
import { AvatarStack } from "./avatar-stack";

// 账户行那一排层叠头像:这个账户里都有什么 —— 现货的币、永续在交易的币、有仓位的 DeFi 协议
// (聚合/去重/降序见 accountStackItems)。交给全站统一的 <AvatarStack>,与代币行的多源平台叠标
// 同一组件、同套间距/圈边/回退规则。什么都没有 → null(调用点仍留着行高)。
export function AccountStack({
  balances,
  max = 5,
  size = "md",
}: {
  balances: OverviewBalance[];
  max?: number;
  size?: "sm" | "md";
}) {
  const items = accountStackItems(balances);
  if (items.length === 0) return null;
  return <AvatarStack items={items} max={max} size={size} />;
}
