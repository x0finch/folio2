import type { ConnectorId } from "@folio/connectors";
import { MorphingModal, toast, useMediaQuery } from "@folio/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, X } from "lucide-react";
import { cloneElement, type ReactElement, type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { useConnectorLabels } from "../hooks/use-connector-labels";
import { connectorCredentialSpecsQuery } from "../lib/queries/connectors";
import { invalidateFor } from "../lib/queries/refresh";
import { syncAccount } from "../lib/server/sync";
import { AccountForm } from "./account-fields";
import { ConnectorGrid } from "./connector-grid";
import { CredentialForm } from "./credential-form";

// 补录目标(A3):缺凭据账户点补录 icon 时传入,modal 直接进补录视图(跳过网格,锁定 connector)。
export interface CompleteTarget {
  accountId: string;
  connectorId: ConnectorId;
  credsSafe: Record<string, string>; // safeView 投影:semi 打码片段供识别
}

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
// px-1.5:overflow-y-auto 会连带把 overflow-x 算成裁剪,给边缘装饰(返回键 hover 底、网格 focus ring)留缓冲,
// 免得贴边元素(如带 -ml 的返回键)被横向裁掉;负外边距用 -mx-1.5 抵回,内容左右缘不缩。
function ViewShell({ children }: { children: ReactNode }) {
  return <div className="-mx-1.5 max-h-[78vh] overflow-y-auto px-1.5">{children}</div>;
}

// 两用:自持 open(传 triggerRender,如页面按钮)或受控(传 open/onOpenChange,如全局头部注入的 + 段触发)。
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
  completeFor?: CompleteTarget | null; // 非空 → 补录模式(A3):强开 + 直接进补录视图
  onCompleteClose?: () => void; // 清除补录目标(关闭补录视图)
} = {}) {
  const t = useTranslations("Accounts");
  const queryClient = useQueryClient();
  // 加账户 / 补录凭据同时改账户域与组合域 —— 映射表那一条已经把两个前缀都列上了。
  const refresh = () => invalidateFor(queryClient, "account.write");
  const refreshAfterSync = () => invalidateFor(queryClient, "account.sync");
  const labelOf = useConnectorLabels();
  const isDesktop = useMediaQuery("(min-width: 640px)");
  const [internalOpen, setInternalOpen] = useState(false);
  const controlled = openProp !== undefined;
  // 补录目标存在 → 强开(优先于 add 的 open);无补录时回归原 add 逻辑。
  const completing = completeFor != null;
  const open = completing ? true : controlled ? (openProp ?? false) : internalOpen;
  const setOpen = (v: boolean) => (controlled ? onOpenChange?.(v) : setInternalOpen(v));
  const [step, setStep] = useState<Step>("grid");
  const [connectorId, setConnectorId] = useState<ConnectorId | null>(null);
  // 每次打开重置回网格步(受控/自持皆然):open false→true 才跑,网格↔表单导航不受影响。
  useEffect(() => {
    if (open) {
      setStep("grid");
      setConnectorId(null);
    }
  }, [open]);
  // 字段规格部署内静态 → 长 staleTime,几乎只取一次;仅打开时取,避免账户页挂载即请求(#107 review)。
  const specsQuery = useQuery({ ...connectorCredentialSpecsQuery(), enabled: open });

  const openModal = () => setOpen(true); // 重置由上面的 open effect 负责
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
    void refresh();
    void syncAccount({ data: { accountId: newId } })
      .then(() => refreshAfterSync())
      .catch(() => {});
  };

  // 补录成功(A3):弹"已保存,正在同步…" + 关补录视图 + 立即刷新(账户翻正)+ 后台补一次 sync 填余额。
  // 后台 sync 失败静默(凭据已 live 校验、账户健康;下次同步自会补上)——同 handleDone。
  const handleCompleteDone = () => {
    if (!completeFor) return;
    const { accountId } = completeFor;
    toast.success(t("credSavedSyncing"));
    onCompleteClose?.();
    void refresh();
    void syncAccount({ data: { accountId } })
      .then(() => refreshAfterSync())
      .catch(() => {});
  };

  // viewId 驱动 morph:关闭为 null;补录视图独立 id;否则网格/表单各自的 step 串作 viewId → 两步间形变。
  const viewId = open ? (completing ? "complete" : step) : null;

  return (
    <>
      {/* 触发器:自持模式渲染(克隆注入 onClick);受控模式无触发器(由外部 open 驱动)。 */}
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
              title={labelOf(completeFor.connectorId)}
              subtitle={t("completeAccountHint")}
              onClose={() => onCompleteClose?.()}
            />
            {/* key={accountId} 重挂 → 切账户清空补录字段态。specs 未到位先给空(CredentialForm 内部再筛非 public)。 */}
            <CredentialForm
              key={completeFor.accountId}
              accountId={completeFor.accountId}
              specs={specsQuery.data?.[completeFor.connectorId] ?? []}
              hint={completeFor.credsSafe}
              onDone={handleCompleteDone}
            />
          </ViewShell>
        ) : step === "form" && connectorId ? (
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
