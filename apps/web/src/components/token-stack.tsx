import type { OverviewBalance } from "../lib/account-view";
import { tokenStackItems } from "../lib/token-stack-items";
import { AvatarStack } from "./avatar-stack";

// 账户持有代币的层叠头像:聚合(去重/降序,见 tokenStackItems)后交给全站统一的 <AvatarStack> ——
// 与代币行的多源平台叠标同一组件、同套间距/圈边/回退规则。无持仓 → null。
export function TokenStack({
  balances,
  max = 5,
  size = "md",
}: {
  balances: OverviewBalance[];
  max?: number;
  size?: "sm" | "md";
}) {
  const items = tokenStackItems(balances);
  if (items.length === 0) return null;
  return <AvatarStack items={items} max={max} size={size} />;
}
