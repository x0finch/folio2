import { Button, cn } from "@folio/ui";
import type { ComponentProps, ReactNode } from "react";

// Wraps beUI's `Button` for its press/hover motion. Two deliberate deviations: a round hover
// background (beUI `size="icon"` is `rounded-lg` upstream; overridden here since the registry file
// is already a fork), and `bg-muted` on hover because ghost's `bg-primary/5` is nearly invisible in
// dark mode. Sizes map to 28 / 32 / 36px; the icon size is the caller's.
const SIZE_CLASS = {
  sm: "size-7",
  md: "size-8",
  lg: "size-9",
} as const;

type ButtonProps = ComponentProps<typeof Button>;

export interface IconButtonProps extends Omit<ButtonProps, "size" | "children"> {
  size?: keyof typeof SIZE_CLASS;
  /** Required: an icon-only button has no readable text for screen readers. */
  "aria-label": string;
  children: ReactNode;
}

export function IconButton({
  size = "md",
  variant = "ghost",
  className,
  ...rest
}: IconButtonProps) {
  return (
    <Button
      type="button"
      size="icon"
      variant={variant}
      className={cn("rounded-full hover:bg-muted", SIZE_CLASS[size], className)}
      {...rest}
    />
  );
}
