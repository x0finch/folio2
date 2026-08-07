// @folio/connectors-basic —— 余额子系统契约层:Balance(类型完备的 5-kind zod 判别联合)、
// Connector manifest 契约(account.creds + balance.schema + providers)、creds 字段与 provider 错误。
// 契约见 ADR 0009。registry 组装归 entry(@folio/connectors),不在契约层。
// 安全边界(原则 #5):本包只做 provider 面向的活,永不碰 SECRETS_KEY —— crypto.ts 的加解密原语是纯函数
// (密钥由调用方传入,不读 env),脱敏塑形(seal/open/safeView)归 app lib/creds.ts。
export * from "./balance";
export * from "./connector";
export * from "./connector-error";
export * from "./creds";
export * from "./crypto";
export * from "./errors";
export * from "./note";
export * from "./promise-provider";
