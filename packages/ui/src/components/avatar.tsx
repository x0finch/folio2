"use client";
// 手搓头像(去 Base UI):Fallback 垫底,Image 覆于其上;图加载失败→Image 返回 null→露出 Fallback。

import * as React from "react";
import { useState } from "react";
import { cn } from "@folio/ui/lib/utils";

const AVATAR_SIZE = { default: "size-8", sm: "size-6", lg: "size-10" } as const;

function Avatar({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"span"> & { size?: "default" | "sm" | "lg" }) {
  return (
    <span
      data-slot="avatar"
      data-size={size}
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted select-none",
        AVATAR_SIZE[size],
        className,
      )}
      {...props}
    />
  );
}

function AvatarImage({ className, src, alt = "", ...props }: React.ComponentProps<"img">) {
  const [errored, setErrored] = useState(false);
  if (!src || errored) return null;
  return (
    <img
      data-slot="avatar-image"
      src={src}
      alt={alt}
      onError={() => setErrored(true)}
      className={cn("absolute inset-0 size-full rounded-full object-cover", className)}
      {...props}
    />
  );
}

function AvatarFallback({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background select-none",
        className,
      )}
      {...props}
    />
  );
}

function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background",
        className,
      )}
      {...props}
    />
  );
}

function AvatarGroupCount({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground ring-2 ring-background",
        className,
      )}
      {...props}
    />
  );
}

export { Avatar, AvatarImage, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarBadge };
