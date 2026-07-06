import { useTranslations } from "use-intl";
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

// 通用行卡:左(头像 + 主/副文本)右(上/下两行)。
function RowCard({
  avatar,
  title,
  subtitle,
  primary,
  secondary,
}: {
  avatar?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
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

// 一个账户的全部持仓(卡片列表):现货 / DeFi / 永续三分区(空 → 提示)。
export function AccountHoldingsCards({ balances }: { balances: OverviewBalance[] }) {
  const t = useTranslations("Overview");
  if (balances.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("noSnapshot")}</p>;
  }
  const sections = toAccountSections(balances);
  return (
    <div className="flex flex-col gap-6">
      {sections.spot.length > 0 && <SpotCards rows={sections.spot} />}
      {sections.defi.length > 0 && <DefiCards groups={sections.defi} />}
      {sections.perp && <PerpCards view={sections.perp} />}
    </div>
  );
}
