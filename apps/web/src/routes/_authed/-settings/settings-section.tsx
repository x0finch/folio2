import { cn } from "@folio/ui";
import type { ReactNode } from "react";

export function SettingsSection({
  title,
  action,
  className,
  children,
}: {
  title: string;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex min-h-8 items-center justify-between gap-4">
        <h2 className="font-semibold text-lg">{title}</h2>
        {action}
      </div>
      <div className={cn("flex flex-col gap-6 empty:hidden", className)}>{children}</div>
    </section>
  );
}
