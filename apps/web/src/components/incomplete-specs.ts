import type { InputSpec } from "../lib/server/internal/creds";
// 补录表单要问的字段 = 非 public(semi + secret)—— 即creds 的 isComplete 判"缺凭据"时 gate 的那批。
// public 字段导入时带真值、已知,不重问(缺凭据唯一来源是导入:secret 缺、semi 占位)。保序。
export function incompleteSpecs(specs: readonly InputSpec[]): InputSpec[] {
  return specs.filter((s) => s.type !== "public");
}
