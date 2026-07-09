// @folio/connectors —— 余额子系统入口:再导出契约层(@folio/connectors-basic)+ registry 组装。
// 每个 connector 一份自包含 manifest(account.creds + balance.schema + providers),Balance 为类型
// 完备的 5-kind zod 判别联合。契约见 ADR 0009。
// 安全边界(原则 #5):本子系统只做 provider 面向的活,永不碰 SECRETS_KEY;加解密/脱敏归 app lib/creds.ts。
export * from "@folio/connectors-basic";
export * from "./registry";
