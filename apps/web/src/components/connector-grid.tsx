import type { ConnectorId } from "@folio/connectors";
import { LogoAvatar, SharedLayoutBg } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { connectorLabelFallback } from "../lib/connector-label";
import { connectorCatalogQuery } from "../lib/queries/connectors";

// add-account 下拉的固定分组列表 —— 直接写死(group 展示名 + 该组 connector)。account.connectorId 的
// 取值域即 @folio/connectors 的 ConnectorId(registry 派生的单一事实源,#37d);客户端只 type-only 引
// ConnectorId(不把 registry 运行时打进 client bundle,见 CODING #客户端打包)。
// group 仅是下拉的分区标题(纯展示),不参与任何逻辑;随 connector 增多在对应组加一项。
const CONNECTOR_OPTIONS: { group: string; options: ConnectorId[] }[] = [
  { group: "Manual", options: ["manual"] },
  { group: "On-chain", options: ["evm", "bitcoin", "solana", "sui", "cosmos"] },
  { group: "Exchange", options: ["binance", "okx", "bybit"] },
  { group: "Perp DEX", options: ["hyperliquid"] },
];

// 「添加账户」第一步:连接器网格(纯展示)。分组来自 CONNECTOR_OPTIONS,展示名 + logo 来自 registry 目录
// —— 图标即各 connector manifest 自带的 logo(经 folio logo 代理),
// 加载失败/无图由 LogoAvatar 回退首字母。恒显全部 Connector(创建无唯一性约束 → 同一 connector 可多开)。
//
// 无 card 边框:hover 高亮交给**单个** SharedLayoutBg 的移动 pill —— 全部类型共享一个 layoutId,pill 在整张网格
// (跨组)连续 morph。组标题作 col-span-full 的非交互子元素(pointer-events-none → 不触发 pill、不占格),
// tiles 作格子(inset=0 → pill 恰覆盖单格)。与账户列表/持仓同款交互。纯 onSelect 回调,不含表单/创建逻辑。
export function ConnectorGrid({ onSelect }: { onSelect: (connectorId: ConnectorId) => void }) {
  const { data: catalog } = useQuery(connectorCatalogQuery());
  return (
    <SharedLayoutBg
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      inset={0}
      pillClassName="rounded-xl bg-muted"
    >
      {CONNECTOR_OPTIONS.flatMap((group) => [
        // 组标题:整行、不参与 pill(pointer-events-none),首组不留上边距。
        <div
          key={`group-${group.group}`}
          className="col-span-full pt-3 text-muted-foreground text-xs first:pt-0 pointer-events-none"
        >
          {group.group}
        </div>,
        ...group.options.map((id) => {
          const label = catalog?.[id]?.label ?? connectorLabelFallback(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className="group w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {/* 内容单容器(padding 在此,按钮本身不裁剪 pill);图标 + 名称竖排。 */}
              <div className="flex flex-col items-start gap-2 rounded-xl p-3">
                <LogoAvatar src={catalog?.[id]?.logo} fallback={label} size="sm" alt="" />
                <span className="font-medium text-sm">{label}</span>
              </div>
            </button>
          );
        }),
      ])}
    </SharedLayoutBg>
  );
}
