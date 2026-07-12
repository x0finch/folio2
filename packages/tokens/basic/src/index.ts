// Shim(oracle 合包 Phase 1,expand):`@folio/tokens-basic` 迁入 `@folio/oracle-basic`,
// 本包降为 re-export 转发,现有 import 一行不改。Phase 2(contract)删本 shim、把 import 改到 @folio/oracle。
export * from "@folio/oracle-basic";
