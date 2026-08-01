import type { Note } from "@folio/connectors-basic";
import {
  BouncyAccordion,
  type BouncyAccordionItem,
  SharedLayoutBg,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@folio/ui";
import { useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import {
  type AccountSections,
  type OverviewBalance,
  type SpotRow,
  toAccountSections,
} from "../lib/account-view";
import { formatNumber } from "../lib/format-number";
import { DefiPositions, PerpPositions } from "./holdings-sections";
import { NoteIconGlyph, NoteIndicator, NoteView } from "./notes";
import { TokenRowContent } from "./token-row";

// 账户详情侧栏专用的持仓「卡片列表」渲染(窄容器友好,取代表格)。总览页仍用 holdings-sections 的表格。
// provider 展示 note(note 重设计,两级):
//   · account 级 note(Note[],整钱包)→ 持仓区顶部一个 BouncyAccordion,一段一个 item(BTC 未确认/收款/分布);
//   · balance 级 note(单个 Note,该币锁仓/冻结)→ 现货行标题右侧一个小 icon <NoteIndicator>(hover 开 popover)。

// 现货区:与主页 Tokens 视图同一 <TokenRowContent>(logo + 名称/note · 数量·symbol · 右侧 ValueDelta),
// 承在 SharedLayoutBg 行式列表里(无边框卡,与 DeFi/perp 区一致)。按美元值降序。单账户上下文无多源叠标;
// balance 级 note 作为名称右侧 aside 指示器透传。名称优先富化 name,缺则大写 symbol。
function SpotCards({ rows }: { rows: SpotRow[] }) {
  const fmtNote = useNoteFormatNumber();
  const sorted = [...rows].sort((a, b) => b.usdValue - a.usdValue);
  return (
    <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
      {sorted.map((b) => (
        // 行内 note 弹层打开时把整行抬到兄弟行之上(否则被下一行 z-10 内容盖住,同 perp 行)。
        <div key={b.id} className="rounded-xl px-3 py-2.5 has-[[data-state=open]]:z-20">
          <TokenRowContent
            item={{
              logo: b.logo,
              name: b.name ?? b.symbol.toUpperCase(),
              symbol: b.symbol.toUpperCase(),
              amount: b.amount,
              value: b.usdValue,
              change24h: b.change24h,
            }}
            aside={b.note ? <NoteIndicator note={b.note} formatNumber={fmtNote} /> : undefined}
          />
        </div>
      ))}
    </SharedLayoutBg>
  );
}

// <NoteView>/<NoteIndicator> 的注入接线:数字值 locale 格式化(全精度,核对用);label/title 英文字面无需 translate。
// 通用渲染包不直接依赖 use-intl / @folio/fx(格式化前端做、跟随 locale)。
function useNoteFormatNumber(): (n: number) => string {
  const locale = useLocale();
  return (n: number) => formatNumber(n, { compact: false, maxFractionDigits: 8, locale });
}

// account 级 note 手风琴(note 重设计):Note[] → 一个 BouncyAccordion,一段一个 item ——
// item.icon = 段状态图标、item.title = 段标题、展开体 = 该段内容(<NoteView hideHeader>)。无段 → null。
function AccountNoteAccordion({ notes }: { notes: Note[] }) {
  const fmtNote = useNoteFormatNumber();
  if (notes.length === 0) return null;
  const items: BouncyAccordionItem[] = notes.map((n, i) => ({
    // 段无稳定跨渲染 id,index 作 id(→ 手风琴 React key);展示列表不重排。
    id: String(i),
    icon: <NoteIconGlyph icon={n.icon} />,
    title: n.title,
    description: <NoteView note={n} hideHeader formatNumber={fmtNote} />,
  }));
  return <BouncyAccordion items={items} classNames={{ description: "text-foreground" }} />;
}

// 持仓分区:tokens(现货)/ perps(永续)/ defi。顺序对齐主页 tab。
type HoldingTab = "tokens" | "perps" | "defi";

// 数据驱动的 tab 存在性(同主页 Overview):无该类持仓不出 tab。
function availableHoldingTabs(sections: AccountSections): HoldingTab[] {
  return [
    sections.spot.length > 0 && "tokens",
    sections.perp && "perps",
    sections.defi.length > 0 && "defi",
  ].filter(Boolean) as HoldingTab[];
}

// 单个分区的内容(tab 内 / 单分区直渲共用)。tab 标签即标题 → 内层一律 hideHeader。
function HoldingSection({ tab, sections }: { tab: HoldingTab; sections: AccountSections }) {
  if (tab === "tokens") return <SpotCards rows={sections.spot} />;
  // 单账户上下文:不传 accountLabel、DeFi 直接用本账户分组(不经 mergeDefiGroups)。
  if (tab === "defi") return <DefiPositions groups={sections.defi} hideHeader />;
  return sections.perp ? <PerpPositions view={sections.perp} hideHeader /> : null;
}

// 持仓 tab(≥2 个分区时):pill tab 切换,与主页 Overview 同一 beUI 组件。
function HoldingTabs({ tabs, sections }: { tabs: HoldingTab[]; sections: AccountSections }) {
  const t = useTranslations("Overview");
  const [tab, setTab] = useState<string>(tabs[0]);
  // 选中的 tab 因数据变化消失(loader 重跑)→ clamp 回首个可用(同主页)。
  const activeTab = tabs.includes(tab as HoldingTab) ? tab : tabs[0];
  const label: Record<HoldingTab, string> = {
    tokens: t("tokensTab"),
    perps: t("perpsTab"),
    defi: t("defiTab"),
  };
  return (
    <Tabs value={activeTab} onValueChange={setTab} variant="pill" className="flex flex-col gap-4">
      {/* 覆盖 beUI pill 默认轨道底 → 无背景(twMerge 覆盖 vendored className,不改组件)。 */}
      <TabsList className="bg-transparent p-0">
        {tabs.map((k) => (
          <TabsTrigger key={k} value={k}>
            {label[k]}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((k) => (
        <TabsContent key={k} value={k}>
          <HoldingSection tab={k} sections={sections} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

// 一个账户的全部持仓:account 级 note 手风琴(顶部)+ 现货 / DeFi / 永续。
// 多分区 → tab 切换(参考主页);单分区 → 直渲(不出孤零零一个 tab)。
export function AccountHoldingsCards({
  balances,
  accountNote,
}: {
  balances: OverviewBalance[];
  accountNote?: Note[];
}) {
  const t = useTranslations("Overview");
  const sections = toAccountSections(balances); // defi 空组 / 零值现货已在此出口滤除
  const tabs = availableHoldingTabs(sections);
  const hasNote = (accountNote?.length ?? 0) > 0;
  // 无可展示分区且无 account 级 note → 文案。区分「真无快照」与「有余额但全为零值/尘埃被滤空」
  // (后者若照旧只判 balances.length 会漏成空白面板,code review #1)。
  if (tabs.length === 0 && !hasNote) {
    return (
      <p className="text-sm text-muted-foreground">
        {balances.length === 0 ? t("noSnapshot") : t("onlyDustHoldings")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {/* account 级 note(整钱包:BTC 未确认/收款/派生分布)→ 顶部手风琴。无则不渲染。 */}
      {accountNote && accountNote.length > 0 && <AccountNoteAccordion notes={accountNote} />}
      {tabs.length === 1 && <HoldingSection tab={tabs[0]} sections={sections} />}
      {tabs.length > 1 && <HoldingTabs tabs={tabs} sections={sections} />}
    </div>
  );
}
