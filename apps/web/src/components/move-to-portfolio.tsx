import { Button, Input, MorphingModal, toast, useMediaQuery } from "@folio/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Check, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { usePortfolio } from "../lib/hooks/use-portfolio";
import { moveAccountToPortfolio } from "../lib/server/portfolio";
import { Portal } from "./portal";

// 抽屉「更多 → 移到 Portfolio」(ADR 0033 的归属入口)。列出既有 Portfolio(点选即移),
// 外加「新建…」一行(输入名 → 一步「建命名 Portfolio + 归属」)。移完 invalidate 让选择器/视图刷新。
export function MoveToPortfolio({
  accountId,
  currentPortfolioId,
  open,
  onClose,
}: {
  accountId: string;
  currentPortfolioId?: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("Portfolio");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { portfolios } = usePortfolio();
  const [newName, setNewName] = useState("");
  const isDesktop = useMediaQuery("(min-width: 640px)");

  const moveMut = useMutation({
    mutationFn: (input: { portfolioId?: string; newName?: string }) =>
      moveAccountToPortfolio({ data: { accountId, ...input } }),
    onSuccess: async () => {
      setNewName("");
      onClose();
      await router.invalidate();
      toast.success(t("moved"));
    },
    onError: () => toast.error(t("moveFailed")),
  });

  const trimmed = newName.trim();

  return (
    <Portal>
      <MorphingModal
        viewId={open ? "move-portfolio" : null}
        onClose={onClose}
        placement={isDesktop ? "center" : "bottom"}
        className="max-w-sm"
      >
        <div className="flex flex-col gap-3">
          <p className="font-medium text-foreground text-sm">{t("moveToTitle")}</p>
          <div className="flex flex-col gap-0.5">
            {portfolios.map((p) => {
              const current = p.id === currentPortfolioId;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={current || moveMut.isPending}
                  className="flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50"
                  onClick={() => moveMut.mutate({ portfolioId: p.id })}
                >
                  <Check className={current ? "size-4 shrink-0" : "size-4 shrink-0 opacity-0"} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                </button>
              );
            })}
          </div>
          {/* 新建命名 Portfolio + 归属(一步)。 */}
          <div className="flex items-center gap-2 border-border border-t pt-3">
            <Input
              value={newName}
              onChange={(v) => setNewName(v)}
              placeholder={t("newPortfolioPlaceholder")}
              className="h-9"
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={!trimmed || moveMut.isPending}
              onClick={() => moveMut.mutate({ newName: trimmed })}
              aria-label={t("createPortfolio")}
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={moveMut.isPending}>
              {tc("cancel")}
            </Button>
          </div>
        </div>
      </MorphingModal>
    </Portal>
  );
}
