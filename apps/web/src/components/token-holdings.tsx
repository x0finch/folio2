import { SharedLayoutBg } from "@folio/ui";
import { useState } from "react";
import { useTranslations } from "use-intl";
import type { Holding } from "../lib/aggregate";
import { buildStack } from "../lib/stack-items";
import { TokenRowContent } from "./token-row";
import { TokenSheet } from "./token-sheet";

// 按代币聚合的持仓列表(v2:LogoAvatar + 名称/symbol / 数量 · 价格 / 市值 · 24h;点击行 → 详情抽屉)。
// hover 高亮由 beUI SharedLayoutBg 的移动滑块承载(行间无分隔线),小额(< DUST_THRESHOLD)折叠进 footer。
const DUST_THRESHOLD = 1; // USD;待定阈值
// 持仓总数 < 此值时不折叠小额:列表本就短,折叠反而多一层交互、没收益。
const MIN_FOLD_COUNT = 10;

// 行内容:统一走 <TokenRowContent>(与账户详情抽屉现货区同组件)。多源(sources > 1)在名称右侧
// 叠放各来源 logo,一眼看出散在哪几处;数量 = 各源汇总(多链/多源也合计,见 aggregate)。
function RowContent({ h }: { h: Holding }) {
  return (
    <TokenRowContent
      item={{
        logo: h.token.logo,
        name: h.token.name,
        symbol: h.token.symbol,
        amount: h.totalAmount,
        value: h.totalValue,
        // 主页这条路已接 24h 盈亏(ADR 0040)—— server 算好的分段结果,不再由 change24h 倒推。
        // 主页这条路的 holding 恒带这个字段(overview 里逐行赋值,算不出是 null),原样透传。
        gain24h: h.gain24h,
      }}
      // 这个币散在哪些来源(账户×平台各占一格 —— 同一平台的两个账户是两格,见 AvatarStack 的
      // `k` 注释)。经 buildStack 按金额降序(全站叠标同一条规则);**只排不砍**(`dust: 0`):
      // 来源就是「这个币在哪」,一个小额来源也是来源,而且开了 dust 开关看尘埃币时砍完会一格不剩。
      sources={buildStack(
        h.sources.map((s) => ({
          logo: s.platform.logo,
          name: s.platform.name,
          k: `${s.account.id}|${s.platform.id}`,
          magnitude: s.value,
        })),
        0,
      )}
    />
  );
}

// 行按钮:作为 SharedLayoutBg 的直接 DOM 子元素(组件元素收不到注入的 relative/onMouseEnter,
// 故不能包成 <HoldingRow>);onClick 保留,className 会被 cloneElement 合上 "relative"。
const rowClass = "w-full rounded-xl px-3 py-3 text-left";

export function TokenHoldings({
  holdings,
  selectedKey,
  onSelect,
}: {
  holdings: Holding[];
  /** 打开的是哪个币(URL 的 `?token=`)。由首页那层给 —— 见 index.tsx 的 `useTokenParam`。 */
  selectedKey?: string;
  onSelect: (key: string | undefined) => void;
}) {
  const t = useTranslations("Overview");
  const [showDust, setShowDust] = useState(false);
  // 认不出的值(旧链接指向已清空的币、手写乱码)→ 找不到就是没开。回落**必须在这里**,不在 route 的
  // `validateSearch` 里:本组件的两个实例各拿一份 holdings(主列表 / 自定义 Tab),同一个 key
  // 在哪份里认得出是各自的事,route 层看不到这个。
  const selected = holdings.find((h) => h.key === selectedKey) ?? null;
  // 少于 MIN_FOLD_COUNT 个持仓 → 全展开、不折叠;否则小额行按阈值收进 toggle。
  const canFold = holdings.length >= MIN_FOLD_COUNT;
  const main = canFold ? holdings.filter((h) => h.totalValue >= DUST_THRESHOLD) : holdings;
  const dust = canFold ? holdings.filter((h) => h.totalValue < DUST_THRESHOLD) : [];
  const rows = showDust ? [...main, ...dust] : main;

  return (
    <>
      <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
        {rows.map((h) => (
          <button key={h.key} type="button" onClick={() => onSelect(h.key)} className={rowClass}>
            <RowContent h={h} />
          </button>
        ))}
      </SharedLayoutBg>
      {/* 小额 toggle:独立按钮(不进 SharedLayoutBg 的移动滑块)。
          · 展开态 → 紧凑浮动 chip,sticky 居中钉在列表可视区底部(实底 + 边框 + 阴影),
            长小额列表滚动时随时可见可收起,不必滑到全部代币的最底部。
          · 折叠态 → 行式全宽入口,随列表流。 */}
      {dust.length > 0 &&
        (showDust ? (
          <div className="sticky bottom-3 z-20 flex justify-start">
            <button
              type="button"
              onClick={() => setShowDust(false)}
              className="rounded-full border border-border bg-card px-4 py-2 text-muted-foreground text-sm hover:text-foreground"
            >
              {t("hideSmall")} ▴
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowDust(true)}
            className="w-full rounded-xl px-3 py-3 text-left text-muted-foreground text-sm hover:text-foreground"
          >
            {t("smallHoldings", { n: dust.length })} ▸
          </button>
        ))}
      <TokenSheet
        holding={selected}
        open={selected != null}
        onOpenChange={(o) => {
          if (!o) onSelect(undefined);
        }}
      />
    </>
  );
}
