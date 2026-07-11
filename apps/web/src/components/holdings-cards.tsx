import type { Note } from "@folio/connectors-basic";
import { NoteBadge, NoteIconGlyph, NoteView } from "@folio/notes";
import { BouncyAccordion, type BouncyAccordionItem } from "@folio/ui";
import { useLocale, useTranslations } from "use-intl";
import {
  type DefiGroup,
  type OverviewBalance,
  type SpotRow,
  toAccountSections,
} from "../lib/account-view";
import { formatNumber } from "../lib/format-number";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import type { PerpView } from "../lib/perp";
import { TokenAvatar } from "./token-stack";

// 账户详情侧栏专用的持仓「卡片列表」渲染(窄容器友好,取代表格)。总览页仍用 holdings-sections 的表格。
// provider 展示 note(note 重设计,两级):
//   · account 级 note(Note[],整钱包)→ 持仓区顶部一个 BouncyAccordion,一段一个 item(BTC 未确认/收款/分布);
//   · balance 级 note(单个 Note,该币锁仓/冻结)→ 现货行副行一个 <NoteBadge>(click 开 popover)。

// 24h 涨跌:正绿(前景)/ 负红(destructive);无数据 → "—"。仅用 shadcn token。
function Change24h({ value }: { value?: number }) {
  if (value == null) return <span className="text-xs text-muted-foreground">—</span>;
  const sign = value >= 0 ? "+" : "";
  return (
    <span className={`text-xs ${value < 0 ? "text-destructive" : "text-muted-foreground"}`}>
      {sign}
      {value.toFixed(2)}%
    </span>
  );
}

// 通用行卡:左(头像 + 主/副文本 + 可选 badge 小行)右(上/下两行)。
function RowCard({
  avatar,
  title,
  subtitle,
  badge,
  primary,
  secondary,
}: {
  avatar?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  badge?: React.ReactNode;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
      {avatar}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{title}</span>
        {subtitle != null && (
          <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
        )}
        {/* balance 级 note badge:独占一小行(避免和副行文本挤/换行;窄容器友好)。 */}
        {badge != null && <span className="mt-1 inline-flex">{badge}</span>}
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className="text-sm font-medium">{primary}</span>
        {secondary}
      </div>
    </div>
  );
}

function SpotCards({ rows }: { rows: SpotRow[] }) {
  const usd = useDisplayValue();
  const fmtNote = useNoteFormatNumber();
  return (
    <div className="flex flex-col gap-2">
      {rows.map((b) => (
        <RowCard
          key={b.id}
          avatar={<TokenAvatar symbol={b.symbol} logo={b.logo} />}
          title={b.symbol.toUpperCase()}
          subtitle={
            <>
              {formatNumber(b.amount)}
              {b.unitPrice != null ? ` · ${usd(b.unitPrice)}` : ""}
            </>
          }
          badge={b.note ? <NoteBadge note={b.note} formatNumber={fmtNote} /> : undefined}
          primary={usd(b.usdValue)}
          secondary={<Change24h value={b.change24h} />}
        />
      ))}
    </div>
  );
}

function DefiCards({ groups }: { groups: DefiGroup[] }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.protocol} className="flex flex-col gap-2">
          <p className="text-sm font-medium">{g.protocol}</p>
          {g.rows.map((r) => (
            <RowCard
              key={r.id}
              title={r.symbol}
              subtitle={<span className="capitalize">{r.positionType ?? t("type")}</span>}
              primary={
                <span className={r.usdValue < 0 ? "text-destructive" : undefined}>
                  {usd(r.usdValue)}
                </span>
              }
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function PerpCards({ view }: { view: PerpView }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  const { equity, positions } = view;
  return (
    <div className="flex flex-col gap-2">
      {equity && (
        <p className="text-xs text-muted-foreground">
          {t("withdrawableMargin", {
            withdrawable: usd(equity.withdrawable),
            margin: usd(equity.totalMarginUsed),
          })}
        </p>
      )}
      {positions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noOpenPositions")}</p>
      ) : (
        positions.map((p) => (
          <RowCard
            key={p.coin}
            title={
              <>
                {p.coin} <span className="text-xs text-muted-foreground">{t(p.side)}</span>
              </>
            }
            subtitle={`${formatNumber(Math.abs(p.size))}${p.leverage != null ? ` · ${p.leverage}x` : ""}`}
            primary={
              <span className={p.unrealizedPnl < 0 ? "text-destructive" : undefined}>
                {usd(p.unrealizedPnl)}
              </span>
            }
            secondary={
              p.liquidationPx != null ? (
                <span className="text-xs text-muted-foreground">
                  {t("liq")} {usd(p.liquidationPx)}
                </span>
              ) : undefined
            }
          />
        ))
      )}
    </div>
  );
}

// <NoteView>/<NoteBadge> 的注入接线:数字值 locale 格式化(全精度,核对用);label/title 英文字面无需 translate。
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
  return (
    <BouncyAccordion
      items={items}
      classNames={{ item: "border border-border", description: "text-foreground" }}
    />
  );
}

// 一个账户的全部持仓(卡片列表):account 级 note 手风琴(顶部)+ 现货(带 balance note badge)/ DeFi / 永续。
export function AccountHoldingsCards({
  balances,
  accountNote,
}: {
  balances: OverviewBalance[];
  accountNote?: Note[];
}) {
  const t = useTranslations("Overview");
  // 空持仓且无 account 级 note → 无快照文案。有 account note(如零余额 xpub 的收款地址)仍渲染其手风琴。
  if (balances.length === 0 && (accountNote?.length ?? 0) === 0) {
    return <p className="text-sm text-muted-foreground">{t("noSnapshot")}</p>;
  }
  const sections = toAccountSections(balances);
  return (
    <div className="flex flex-col gap-6">
      {/* account 级 note(整钱包:BTC 未确认/收款/派生分布)→ 顶部手风琴。无则不渲染。 */}
      {accountNote && accountNote.length > 0 && <AccountNoteAccordion notes={accountNote} />}
      {sections.spot.length > 0 && <SpotCards rows={sections.spot} />}
      {sections.defi.length > 0 && <DefiCards groups={sections.defi} />}
      {sections.perp && <PerpCards view={sections.perp} />}
    </div>
  );
}
