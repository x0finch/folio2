import type { AddressListBlock } from "@folio/detail-block-basic";
import { CheckIcon, CopyIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { useDetailContext } from "../detail-context";

// 地址中缩:首 10 + 尾 6,便于核对又不占宽。
function shortAddress(a: string): string {
  return a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;
}

const COPIED_RESET_MS = 1500;

// 复制按钮:点击写剪贴板,短暂切到 √ 反馈(自包含,不依赖 app toast)。
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      // aria-label 是无障碍功能标签(非展示文案),保持稳定英文。
      aria-label="Copy address"
      className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), COPIED_RESET_MS);
      }}
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}

// addressList 原语:地址列表,自带复制;块开 qr 时每项渲染二维码。
// 用于 xpub 派生地址分布 / 收款地址指引等(BTC 迁移片吐块)。
export function AddressList({ block }: { block: AddressListBlock }) {
  const { translate, format } = useDetailContext();
  const items = (block.items ?? []).filter((it) => Boolean(it.address)); // 缺 address 的项不画
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {block.label != null && <p className="text-sm font-medium">{translate(block.label)}</p>}
      {items.map((item) => {
        const meta = item.path ?? (item.index != null ? `#${item.index}` : null);
        const pendingSats = item.pendingSats;
        const showPending = pendingSats != null && pendingSats !== 0;
        return (
          <div key={item.address} className="flex flex-col gap-2 rounded-md border px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-xs" title={item.address}>
                  {shortAddress(item.address)}
                </span>
                {meta != null && (
                  <span className="truncate text-xs text-muted-foreground">{meta}</span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {item.balanceSats != null && (
                  <span className="text-sm font-medium">{format(item.balanceSats, "sats")}</span>
                )}
                <CopyButton value={item.address} />
              </div>
            </div>
            {showPending && (
              <span className="text-xs text-muted-foreground">{format(pendingSats, "sats")}</span>
            )}
            {block.qr && (
              // 二维码需浅底 + 深模块才可扫,与主题无关 → 固定白底(功能性,非装饰色)。
              <div className="self-center rounded-md bg-white p-2">
                <QRCodeSVG value={item.address} size={128} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
