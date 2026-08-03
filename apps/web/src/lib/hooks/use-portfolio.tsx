import { createContext, type ReactNode, useContext, useState } from "react";

// 当前选中的 Portfolio(ADR 0033)。主页 / 账户页 / Insights 共享同一个选中态 —— 住 _authed 布局层,
// 选谁三页都 scope 到谁。**不持久化**:选中态只在内存(React state),硬刷新 / 重开回默认 Portfolio。
// 软导航(页间跳转)因布局不卸载而保留选中。

export interface PortfolioSummary {
  id: string;
  name: string;
  isDefault: boolean;
}

interface PortfolioContextValue {
  portfolios: PortfolioSummary[];
  defaultId: string;
  selectedId: string;
  select: (id: string) => void;
}

const PortfolioContext = createContext<PortfolioContextValue | null>(null);

export function PortfolioProvider({
  portfolios,
  defaultId,
  children,
}: {
  portfolios: PortfolioSummary[];
  defaultId: string;
  children: ReactNode;
}) {
  // 选中态初始为默认(硬刷新回默认即由「布局重挂 → 这里重新初始化」实现)。
  const [selectedId, setSelectedId] = useState(defaultId);
  // 选中的 Portfolio 若已不存在(如被删)→ 退回默认,避免指向空视图。
  const effectiveSelected = portfolios.some((p) => p.id === selectedId) ? selectedId : defaultId;
  return (
    <PortfolioContext.Provider
      value={{ portfolios, defaultId, selectedId: effectiveSelected, select: setSelectedId }}
    >
      {children}
    </PortfolioContext.Provider>
  );
}

export function usePortfolio(): PortfolioContextValue {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error("usePortfolio must be used within PortfolioProvider");
  return ctx;
}
