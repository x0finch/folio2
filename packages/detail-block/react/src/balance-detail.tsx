import type { DetailBlock } from "@folio/detail-block-basic";
import { cn } from "@folio/ui/lib/utils";
import { useMemo } from "react";
import { DetailContextProvider, type DetailRenderContext } from "./detail-context";
import { AddressList } from "./primitives/address-list";
import { KeyValue } from "./primitives/key-value";
import { Stat } from "./primitives/stat";

export interface BalanceDetailProps extends DetailRenderContext {
  blocks?: DetailBlock[];
  className?: string;
}

// 词汇表 v1 已知块 type(封闭)。未列入者(旧快照 / 将来新块)一律跳过,不崩。
const KNOWN_BLOCK_TYPES: ReadonlySet<string> = new Set(["stat", "keyValue", "addressList"]);

function isRenderable(block: DetailBlock): boolean {
  return KNOWN_BLOCK_TYPES.has((block as { type?: unknown }).type as string);
}

// 单块分派:按 type 选原语。永不判断业务身份(BTC/CEX),只按画法。
function BlockView({ block }: { block: DetailBlock }) {
  switch (block.type) {
    case "stat":
      return <Stat block={block} />;
    case "keyValue":
      return <KeyValue block={block} />;
    case "addressList":
      return <AddressList block={block} />;
    default:
      return null; // 未知块跳过(穷尽 switch 的运行时兜底)
  }
}

// 通用详情渲染器:map + switch(type) 分派到原语。app 注入 translate / format(见 DetailRenderContext)。
// 无块(或全被跳过)→ 渲染 null,现有行为不受影响。
export function BalanceDetail({ blocks, translate, format, className }: BalanceDetailProps) {
  const ctx = useMemo<DetailRenderContext>(() => ({ translate, format }), [translate, format]);
  const visible = (blocks ?? []).filter(isRenderable);
  if (visible.length === 0) return null;
  return (
    <DetailContextProvider value={ctx}>
      <div className={cn("flex flex-col gap-4", className)}>
        {visible.map((block, i) => (
          // 块无稳定 id,index 作 key(detail 是只读展示袋,不重排)。
          // biome-ignore lint/suspicious/noArrayIndexKey: detail blocks are a static display list
          <BlockView key={i} block={block} />
        ))}
      </div>
    </DetailContextProvider>
  );
}
