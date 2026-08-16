import type { ReactNode } from "react";

// 标签左、控件右对齐的设置行(单行 justify-between)。
export function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  );
}
