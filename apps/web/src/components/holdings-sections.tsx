import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@folio/ui";
import { useFormatter, useTranslations } from "use-intl";
import {
  type DefiGroup,
  type OverviewBalance,
  type SpotRow,
  toAccountSections,
} from "../lib/account-view";
import type { PerpView } from "../lib/perp";

// 账户持仓渲染:总览页每账户卡与账户详情侧栏共用(从 routes/_authed/index.tsx 提取)。
// locale 感知的美元格式化(货币恒 USD,locale 决定分隔符)。
export function useUsd() {
  const format = useFormatter();
  return (n: number) => format.number(n, { style: "currency", currency: "USD" });
}

// 现货/CEX/manual:数量 + 美元价值。
function SpotTable({ rows }: { rows: SpotRow[] }) {
  const t = useTranslations("Overview");
  const usd = useUsd();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("asset")}</TableHead>
          <TableHead className="text-right">{t("price")}</TableHead>
          <TableHead className="text-right">{t("change24h")}</TableHead>
          <TableHead className="text-right">{t("amount")}</TableHead>
          <TableHead className="text-right">{t("value")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((b) => (
          <TableRow key={b.id}>
            <TableCell>
              <AssetCell symbol={b.symbol} name={b.name} logo={b.logo} />
            </TableCell>
            <TableCell className="text-right">
              {b.unitPrice != null ? usd(b.unitPrice) : "—"}
            </TableCell>
            <TableCell className="text-right">
              <Change24h value={b.change24h} />
            </TableCell>
            <TableCell className="text-right">{b.amount}</TableCell>
            <TableCell className="text-right">{usd(b.usdValue)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// 资产单元:logo(热链,失败回退到 symbol 首字母圆标)+ 名称/symbol。
function AssetCell({ symbol, name, logo }: { symbol: string; name?: string; logo?: string }) {
  return (
    <div className="flex items-center gap-2">
      {logo ? (
        <img
          src={logo}
          alt=""
          width={20}
          height={20}
          className="size-5 rounded-full"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : (
        <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
          {symbol.slice(0, 1)}
        </span>
      )}
      <span>{name ?? symbol}</span>
      {name ? <span className="text-xs text-muted-foreground">{symbol}</span> : null}
    </div>
  );
}

// 24h 涨跌:正绿(默认前景)/ 负红(destructive token);无数据 → "—"。仅用 shadcn token,不硬编码色。
function Change24h({ value }: { value?: number }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const sign = value >= 0 ? "+" : "";
  return (
    <span className={value < 0 ? "text-destructive" : "text-foreground"}>
      {sign}
      {value.toFixed(2)}%
    </span>
  );
}

// DeFi:按协议分组,每组一张小表(Asset / 仓位类型 / 价值)。负值=负债(借出)→ 标红。
function DefiPositions({ groups }: { groups: DefiGroup[] }) {
  const t = useTranslations("Overview");
  const usd = useUsd();
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.protocol} className="flex flex-col gap-2">
          <p className="text-sm font-medium">{g.protocol}</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("asset")}</TableHead>
                <TableHead>{t("type")}</TableHead>
                <TableHead className="text-right">{t("value")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.symbol}</TableCell>
                  <TableCell className="capitalize text-muted-foreground">
                    {r.positionType ?? "—"}
                  </TableCell>
                  <TableCell className={`text-right ${r.usdValue < 0 ? "text-destructive" : ""}`}>
                    {usd(r.usdValue)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </div>
  );
}

// 永续:净值由外层承载;此处展示可提/保证金副行 + 仓位明细(方向/盈亏/杠杆/强平)。
function PerpPositions({ view }: { view: PerpView }) {
  const t = useTranslations("Overview");
  const usd = useUsd();
  const { equity, positions } = view;
  return (
    <div className="flex flex-col gap-3">
      {equity && (
        <p className="text-sm text-muted-foreground">
          {t("withdrawableMargin", {
            withdrawable: usd(equity.withdrawable),
            margin: usd(equity.totalMarginUsed),
          })}
        </p>
      )}
      {positions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noOpenPositions")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("token")}</TableHead>
              <TableHead>{t("side")}</TableHead>
              <TableHead className="text-right">{t("size")}</TableHead>
              <TableHead className="text-right">{t("entry")}</TableHead>
              <TableHead className="text-right">{t("upnl")}</TableHead>
              <TableHead className="text-right">{t("lev")}</TableHead>
              <TableHead className="text-right">{t("liq")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.map((p) => (
              <TableRow key={p.coin}>
                <TableCell>{p.coin}</TableCell>
                <TableCell>{t(p.side)}</TableCell>
                <TableCell className="text-right">{Math.abs(p.size)}</TableCell>
                <TableCell className="text-right">{usd(p.entryPx)}</TableCell>
                <TableCell
                  className={`text-right ${p.unrealizedPnl < 0 ? "text-destructive" : ""}`}
                >
                  {usd(p.unrealizedPnl)}
                </TableCell>
                <TableCell className="text-right">
                  {p.leverage != null ? `${p.leverage}x` : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {p.liquidationPx != null ? usd(p.liquidationPx) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// 一个账户的全部持仓:现货 / DeFi / 永续三分区(空 → 提示)。表格在窄容器(详情侧栏)下可横向滚动。
export function AccountHoldings({ balances }: { balances: OverviewBalance[] }) {
  const t = useTranslations("Overview");
  if (balances.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("noSnapshot")}</p>;
  }
  const sections = toAccountSections(balances);
  return (
    <div className="flex flex-col gap-6 overflow-x-auto">
      {sections.spot.length > 0 && <SpotTable rows={sections.spot} />}
      {sections.defi.length > 0 && <DefiPositions groups={sections.defi} />}
      {sections.perp && <PerpPositions view={sections.perp} />}
    </div>
  );
}
