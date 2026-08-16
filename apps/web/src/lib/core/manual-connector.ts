import type { ConnectorId } from "@folio/connectors";

// manual connector 的 id —— app 侧「是不是 manual 账户」判别的**单一事实源**。
// manual = 值靠 creds 现造、不联网同步的账户(ADR 0018);Q2 决定用 app 侧写死判别而非 manifest 能力位,
// 故散落各处的 connectorId === "manual" 全收此,避免字面量遍地。
//
// **本文件只放这个身份判别,不放写路径的东西。** 它被组件 import(渲染哪套字段要问「是不是手记」),
// 所以它拖进来的依赖会跟着进客户端的依赖图。原来这里还住着 `manualTokenRef`,于是每个 import
// `isManual` 的组件都顺带依赖了 tokenRef 文法包 —— tree-shaking 当时摘掉了它,但那是打包器的结果、
// 不是不变量:这文件哪天多一行副作用,文法就悄悄跟着出去了。造 ref 是写路径的活,
// 已挪到它唯一的调用者旁边(`server/internal/manual.ts`)。
export const MANUAL_CONNECTOR_ID = "manual" satisfies ConnectorId;

export function isManual(connectorId: ConnectorId): boolean {
  return connectorId === MANUAL_CONNECTOR_ID;
}
