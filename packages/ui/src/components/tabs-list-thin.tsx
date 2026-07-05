import { cn } from "@folio/ui/lib/utils";
import { TabsList, TabsTrigger } from "./tabs";

// 细线下划 Tab(复刻 folio-old/components/ui/tabs-list-thin):透明背景、底部一条 muted 基线,
// 激活项下 foreground 下划线。用已注册的 data-active 变体(Base UI 的 [data-active]),不依赖 base-vega 的
// group-data-* 变体(那些未注册)。配合 @folio/ui 的 <Tabs> 使用。
export function TabsListThin({ className, ...props }: React.ComponentProps<typeof TabsList>) {
  return (
    <TabsList
      className={cn(
        "h-auto w-full justify-start gap-6 rounded-none border-b border-border bg-transparent p-0",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTriggerThin({ className, ...props }: React.ComponentProps<typeof TabsTrigger>) {
  return (
    <TabsTrigger
      className={cn(
        "relative flex-none rounded-none border-none bg-transparent px-1 pb-2.5 pt-1 text-sm font-medium capitalize text-muted-foreground shadow-none",
        "data-active:bg-transparent data-active:text-foreground data-active:shadow-none",
        "data-active:after:absolute data-active:after:inset-x-0 data-active:after:-bottom-px data-active:after:h-0.5 data-active:after:rounded-full data-active:after:bg-foreground",
        className,
      )}
      {...props}
    />
  );
}
