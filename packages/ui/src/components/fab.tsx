import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@folio/ui/lib/utils";

// 悬浮操作按钮(FAB):右下圆钮,承载主操作(刷新/添加)。复刻 folio-old/components/ui/fab。
// forwardRef + 透传 props,可作 Base UI Trigger 的 render 目标(如 SheetTrigger render={<Fab/>})。
const fabVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium shadow-lg transition-all duration-200 ease-out outline-none transform-gpu cursor-pointer hover:shadow-xl hover:scale-105 hover:-translate-y-0.5 active:scale-95 active:translate-y-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
        surface:
          "bg-background text-foreground border border-border hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-14 w-14 [&_svg]:size-5",
        mini: "h-11 w-11 [&_svg]:size-4",
      },
      position: {
        "bottom-right": "fixed bottom-6 right-6 z-40",
        static: "relative",
      },
    },
    defaultVariants: { variant: "default", size: "default", position: "static" },
  },
);

export interface FabProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof fabVariants> {
  icon?: React.ReactNode;
}

export const Fab = React.forwardRef<HTMLButtonElement, FabProps>(
  ({ className, variant, size, position, icon, children, type = "button", ...props }, ref) => (
    // biome-ignore lint/a11y/useButtonType: type defaulted to "button" above
    <button
      ref={ref}
      type={type}
      data-slot="fab"
      className={cn(fabVariants({ variant, size, position }), className)}
      {...props}
    >
      {icon}
      {children}
    </button>
  ),
);
Fab.displayName = "Fab";

export { fabVariants };
