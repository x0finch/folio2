// @folio/connectors —— 余额子系统:每个 connector 一份自包含 manifest(account.creds + balance.schema
// + providers),Balance 为类型完备的 5-kind zod 判别联合。契约见 ADR 0009。
// 安全边界(原则 #5):本包只做 provider 面向的活,永不碰 SECRETS_KEY;加解密/脱敏归 app lib/creds.ts。
export * from "./balance";
export * from "./connector";
export * from "./creds";
export * from "./errors";
export * from "./registry";
