import type { ConnectorId } from "@folio/connectors";
import { MorphingModal, toast, useMediaQuery } from "@folio/ui";
import { ArrowLeft, X } from "@folio/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cloneElement, type ReactElement, type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { AccountForm } from "@/components/account-fields";
import { ConnectorGrid } from "@/components/connector-grid";
import { CredentialForm } from "@/components/credential-form";
import { IconButton } from "@/components/icon-button";
import { connectorLabelFallback } from "@/lib/core/logo";
import { syncAccountAndWait } from "@/lib/queries/account-sync";
import { connectorCatalogQuery, connectorCredentialSpecsQuery } from "@/lib/queries/connectors";
import { invalidateFor } from "@/lib/queries/refresh";

// Opens the modal straight into the credential-completion view, connector locked.
export interface CompleteTarget {
  accountId: string;
  connectorId: ConnectorId;
  credsSafe: Record<string, string>; // safeView projection: semi fields masked
  missingCreds: readonly string[];
}

// One MorphingModal for both steps (grid ↔ form); `viewId = step` drives the morph.
type Step = "grid" | "form";

// Lives inside the keyed children so it morphs with the view.
function ModalHeader({
  title,
  onBack,
  onClose,
}: {
  title: string;
  onBack?: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  return (
    <div className="mb-6 flex items-center gap-2">
      {onBack && (
        <IconButton size="sm" onClick={onBack} aria-label={t("backToConnectors")} className="-ml-1">
          <ArrowLeft />
        </IconButton>
      )}
      <h2 className="flex-1 font-semibold text-lg">{title}</h2>
      <IconButton size="sm" onClick={onClose} aria-label={tc("close")}>
        <X />
      </IconButton>
    </div>
  );
}

// The panel is overflow-hidden, so content scrolls in its own max-h container. px-2 / -mx-2:
// overflow-y-auto also clips x, so leave room for edge decorations (hover bg, focus rings).
function ViewShell({ children }: { children: ReactNode }) {
  return <div className="-mx-2 max-h-[78vh] overflow-y-auto px-2">{children}</div>;
}

// Self-managed open (pass triggerRender) or controlled (pass open/onOpenChange).
export function AddAccountModal({
  triggerRender,
  open: openProp,
  onOpenChange,
  completeFor,
  onCompleteClose,
}: {
  triggerRender?: ReactElement<{ onClick?: () => void }>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  completeFor?: CompleteTarget | null; // non-null → completion mode, forced open
  onCompleteClose?: () => void;
} = {}) {
  const t = useTranslations("Accounts");
  const queryClient = useQueryClient();
  const refresh = () => invalidateFor(queryClient, "account.write");
  const refreshAfterSync = () => invalidateFor(queryClient, "account.sync");
  // `syncAccount` only enqueues, so wait for the job before refreshing. A sync failure is surfaced
  // (creds were just validated live, so it's likely upstream); a failure to enqueue stays silent
  // since the next sync will catch up.
  const syncInBackground = (accountId: string) =>
    void syncAccountAndWait(queryClient, accountId)
      .then((outcome) => {
        if (!outcome.ok && !outcome.skipped) toast.error(outcome.error ?? t("syncGenericError"));
        return refreshAfterSync();
      })
      .catch(() => {});
  const { data: catalog } = useQuery(connectorCatalogQuery());
  const isDesktop = useMediaQuery("(min-width: 640px)");
  const [internalOpen, setInternalOpen] = useState(false);
  const controlled = openProp !== undefined;
  const completing = completeFor != null;
  const open = completing ? true : controlled ? (openProp ?? false) : internalOpen;
  const setOpen = (v: boolean) => (controlled ? onOpenChange?.(v) : setInternalOpen(v));
  const [step, setStep] = useState<Step>("grid");
  const [connectorId, setConnectorId] = useState<ConnectorId | null>(null);
  // Reset to the grid on every open (false → true only), so grid ↔ form navigation is unaffected.
  useEffect(() => {
    if (open) {
      setStep("grid");
      setConnectorId(null);
    }
  }, [open]);
  // Fetch only when open, so mounting the accounts page doesn't trigger a request.
  const specsQuery = useQuery({ ...connectorCredentialSpecsQuery(), enabled: open });

  const openModal = () => setOpen(true); // the open effect above resets the step
  const close = () => setOpen(false);
  const pick = (id: ConnectorId) => {
    setConnectorId(id);
    setStep("form");
  };
  const back = () => {
    setStep("grid");
    setConnectorId(null);
  };
  const handleDone = (newId: string) => {
    setOpen(false);
    void refresh();
    syncInBackground(newId);
  };

  const handleCompleteDone = () => {
    if (!completeFor) return;
    const { accountId } = completeFor;
    toast.success(t("credSavedSyncing"));
    onCompleteClose?.();
    void refresh();
    syncInBackground(accountId);
  };

  const viewId = open ? (completing ? "complete" : step) : null;

  return (
    <>
      {triggerRender != null && cloneElement(triggerRender, { onClick: openModal })}
      <MorphingModal
        viewId={viewId}
        onClose={completing ? () => onCompleteClose?.() : close}
        placement={isDesktop ? "center" : "bottom"}
        className="max-w-md"
      >
        {completing && completeFor ? (
          <ViewShell>
            <ModalHeader
              title={
                catalog?.[completeFor.connectorId]?.label ??
                connectorLabelFallback(completeFor.connectorId)
              }
              onClose={() => onCompleteClose?.()}
            />
            {/* key remounts to clear field state per account; non-public specs are filtered inside. */}
            <CredentialForm
              key={completeFor.accountId}
              accountId={completeFor.accountId}
              specs={specsQuery.data?.[completeFor.connectorId] ?? []}
              hint={completeFor.credsSafe}
              missing={completeFor.missingCreds}
              onDone={handleCompleteDone}
            />
          </ViewShell>
        ) : step === "form" && connectorId ? (
          <ViewShell>
            <ModalHeader
              title={catalog?.[connectorId]?.label ?? connectorLabelFallback(connectorId)}
              onBack={back}
              onClose={close}
            />
            {/* key remounts to clear field state per connector; manual needs no specs. */}
            <AccountForm
              key={connectorId}
              connectorId={connectorId}
              specs={specsQuery.data?.[connectorId] ?? []}
              onDone={handleDone}
            />
          </ViewShell>
        ) : (
          <ViewShell>
            <ModalHeader title={t("addAccount")} onClose={close} />
            <ConnectorGrid onSelect={pick} />
          </ViewShell>
        )}
      </MorphingModal>
    </>
  );
}
