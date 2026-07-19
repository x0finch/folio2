import type { ConnectorId } from "@folio/connectors";
import { MorphingModal, useMediaQuery } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeft, X } from "lucide-react";
import { cloneElement, type ReactElement, type ReactNode, useState } from "react";
import { useTranslations } from "use-intl";
import { getCredentialSpecs } from "../lib/server/credentials";
import { syncOneAccount } from "../lib/server/sync";
import { useConnectorLabels } from "../lib/use-connector-labels";
import { AccountForm } from "./account-fields";
import { ConnectorGrid } from "./connector-grid";

// 添加账户 modal(A4):单一 MorphingModal 承载两步 —— 网格(grid)↔ 创建表单(form),viewId=step 驱动 morph 形变。
// 桌面居中(placement=center)、手机贴底(placement=bottom);自持 open,经 cloneElement 挂账户页 Fab 触发。
// P2:表单区先放占位骨架,只验证 morph/返回/响应式;真表单在 P4 接入。所有配色只走 design token。
type Step = "grid" | "form";

// modal 内每视图共用的头:返回(仅表单步)+ 标题 + 关闭。放在 keyed children 内,随 viewId 一起 morph。
function ModalHeader({
  title,
  subtitle,
  onBack,
  onClose,
}: {
  title: string;
  subtitle: string;
  onBack?: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  return (
    <div className="mb-4 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label={t("backToConnectors")}
            className="-ml-1 flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
        )}
        <h2 className="flex-1 font-semibold text-lg">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={tc("close")}
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
      <p className="text-muted-foreground text-sm">{subtitle}</p>
    </div>
  );
}

// 面板本体 overflow-hidden 无内滚 → 内容套 max-h 滚动容器,短屏/长表单不被裁。
function ViewShell({ children }: { children: ReactNode }) {
  return <div className="max-h-[78vh] overflow-y-auto">{children}</div>;
}

export function AddAccountModal({ triggerRender }: { triggerRender?: ReactElement } = {}) {
  const t = useTranslations("Accounts");
  const router = useRouter();
  const labelOf = useConnectorLabels();
  const isDesktop = useMediaQuery("(min-width: 640px)");
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("grid");
  const [connectorId, setConnectorId] = useState<ConnectorId | null>(null);
  // 字段规格部署内静态 → 长 staleTime,几乎只取一次。
  const specsQuery = useQuery({
    queryKey: ["credentialSpecs"],
    queryFn: () => getCredentialSpecs(),
    staleTime: 60 * 60_000,
  });

  const openModal = () => {
    setStep("grid");
    setConnectorId(null);
    setOpen(true);
  };
  const close = () => setOpen(false);
  const pick = (id: ConnectorId) => {
    setConnectorId(id);
    setStep("form");
  };
  const back = () => {
    setStep("grid");
    setConnectorId(null);
  };
  // 创建成功:关闭 + 即时出现(此刻空值),再后台同步新账户 → 完成二次 invalidate 填充;失败静默(创建流已校验)。
  const handleDone = (newId: string) => {
    setOpen(false);
    router.invalidate();
    void syncOneAccount({ data: { accountId: newId } })
      .then(() => router.invalidate())
      .catch(() => {});
  };

  // viewId 驱动 morph:关闭为 null;网格/表单各自的 step 串作 viewId → 两步间形变。
  const viewId = open ? step : null;

  return (
    <>
      {cloneElement(triggerRender ?? <button type="button">{t("addAccount")}</button>, {
        onClick: openModal,
      })}
      <MorphingModal
        viewId={viewId}
        onClose={close}
        placement={isDesktop ? "center" : "bottom"}
        className="max-w-md"
      >
        {step === "form" && connectorId ? (
          <ViewShell>
            <ModalHeader
              title={labelOf(connectorId)}
              subtitle={t("addAccountHint")}
              onBack={back}
              onClose={close}
            />
            {/* key={connectorId} 重挂 → 切 connector 清空字段态。specs 未到位时先给空(manual 无需 specs)。 */}
            <AccountForm
              key={connectorId}
              connectorId={connectorId}
              specs={specsQuery.data?.[connectorId] ?? []}
              onDone={handleDone}
            />
          </ViewShell>
        ) : (
          <ViewShell>
            <ModalHeader title={t("addAccount")} subtitle={t("addAccountHint")} onClose={close} />
            <ConnectorGrid onSelect={pick} />
          </ViewShell>
        )}
      </MorphingModal>
    </>
  );
}
