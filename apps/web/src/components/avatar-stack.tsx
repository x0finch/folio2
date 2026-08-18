import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage, cn } from "@folio/ui";
import { ZERO_DISPLAY_USD } from "../lib/core/account-view";

// 叠放的平台/链 logo 小圆(beUI AvatarGroup):缺 logo 回退首字母、title 显名;超 max 以 +N 收尾。
// AvatarImage 垫 bg-logo-bg 恒亮实底 —— 透明 logo 边角不漏 fallback 字母,且不随主题翻转。
// 三处共用:账户行(这个账户里有什么)、代币行(这个币在哪些来源)、详情抽屉(账户跨多链)。
// 排序/去重/砍尘埃在数据那侧统一(见本文件下方的 buildStack),这里只管画。
const SIZES = {
  sm: { avatar: "size-4", text: "text-[8px]" },
  md: { avatar: "size-6", text: "text-[9px]" },
} as const;

export function AvatarStack({
  items,
  size = "sm",
  max = 3,
  className,
}: {
  // k:稳定唯一 key(name 可能重复,如同一平台多账户);缺省回退 name。
  items: { logo?: string; name: string; k?: string }[];
  size?: keyof typeof SIZES;
  max?: number;
  className?: string;
}) {
  const s = SIZES[size];
  // 一格都没有 → 什么都不画(而不是画一个空的 AvatarGroup)。调用点因此可以直接把可能为空的
  // items 交进来,不必各自判一次;要留位置的地方在外面套一个 min-h 就行(见账户页那一行)。
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  const extra = items.length - shown.length;
  return (
    <AvatarGroup className={cn("shrink-0 -space-x-1", className)}>
      {shown.map((a) => (
        <Avatar key={a.k ?? a.name} title={a.name} className={s.avatar}>
          <AvatarImage src={a.logo} alt="" className="bg-logo-bg" />
          <AvatarFallback className={s.text}>{a.name.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
      ))}
      {extra > 0 ? (
        <AvatarGroupCount className={cn(s.avatar, s.text)}>+{extra}</AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  );
}

// 叠标(`<AvatarStack>`)那一排小圆头像的**共同装配**:同键累加 → 砍掉几乎 $0 的 → 按量级降序。
//
// **为什么要有这一处。** 站里有三个地方产这排头像 —— 账户行(这个账户里有什么)、代币行(这个币
// 散在哪些来源)、资产抽屉的来源分组(这个账户跨了哪些平台)。三处的输入、分组键、量级口径各不相同,
// 但**顺序规则**是同一条:大的在前。而它曾经只在其中一处成立 —— 另两处按上游返回的顺序排,也就是
// 没有顺序(#133 收尾发现的:永续仓位列表看着「乱的」,正是这个)。
//
// 所以共用的是**这一段**,不是整个函数:各调用方仍自己回答「怎么把我的一行变成一个 entry」
// (那部分三处不可能一样),然后交给这里排。规则漂移从此只有一个地方能改。
export interface StackItem {
  logo?: string;
  name: string;
  k: string;
}

export interface StackEntry {
  k: string; // 同键合并;**由调用方决定粒度**(账户行按币/协议,代币行按「账户×平台」—— 见各调用点)
  name: string; // 缺 logo 时 <AvatarStack> 回退首字母 + title
  logo?: string;
  // 排序与砍尘埃用的量级。**各处口径不同**(现货带符号的市值 / DeFi 毛敞口 / 永续名义敞口),
  // 所以由调用方算好;这里只按 `|magnitude|` 比大小。
  magnitude: number;
}

/**
 * @param dust 低于它的格子不显示。**默认按展示阈值砍,传 `0` 则只排不砍。**
 *
 * 砍不砍是调用点的事,因为「这排头像是从多少东西里挑出来的」不一样:账户行的输入是**整个账户的
 * 持仓**(几百个空投尘埃币,不砍会糊掉);而来源那两排的输入是**用户确实持有的那个币的几个来源**,
 * 砍掉一个 $0.07 的链会让头像个数与旁边那句「跨 3 个平台」对不上 —— 那是自相矛盾,不是干净。
 */
export function buildStack(
  entries: readonly StackEntry[],
  dust: number = ZERO_DISPLAY_USD,
): StackItem[] {
  const slots = new Map<string, { name: string; logo?: string; magnitude: number }>();
  for (const e of entries) {
    const cur = slots.get(e.k);
    if (!cur) slots.set(e.k, { name: e.name, logo: e.logo, magnitude: e.magnitude });
    else {
      cur.magnitude += e.magnitude;
      // logo 取**首个有图的**,不是首见那一行:同一个键可能先出现在一条还没富化到图的行上。
      cur.logo ??= e.logo;
    }
  }
  return [...slots.entries()]
    .filter(([, s]) => Math.abs(s.magnitude) >= dust)
    .sort(([, a], [, b]) => Math.abs(b.magnitude) - Math.abs(a.magnitude))
    .map(([k, s]) => ({ logo: s.logo, name: s.name, k }));
}
