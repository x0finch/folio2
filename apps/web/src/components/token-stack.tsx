import { Avatar, AvatarFallback, AvatarImage } from "@folio/ui";
import type { OverviewBalance } from "../lib/account-view";
import { tokenStackItems } from "../lib/token-stack-items";
import { AvatarStack } from "./avatar-stack";

// 单个代币头像:shadcn Avatar 二次包装 —— 有 logo 显 logo,加载失败/缺失由 AvatarFallback 回退首字母。
export function TokenAvatar({
  symbol,
  logo,
  size = "sm",
}: {
  symbol: string;
  logo?: string;
  size?: "sm" | "default" | "lg";
}) {
  return (
    <Avatar size={size} className="bg-background">
      {/* 代币 logo 多为透明 PNG:底色 bg-background 填满圆,叠压时不透出后面的头像。 */}
      {logo && <AvatarImage src={logo} alt={symbol} className="bg-background" />}
      <AvatarFallback className="text-[10px]">{symbol.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

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
