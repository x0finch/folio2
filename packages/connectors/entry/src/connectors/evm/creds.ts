import type { CredField } from "@folio/connectors-basic";
import { z } from "zod";
import { EVM_ADDRESS_RE } from "./constants";

// —— 账户级 creds(AC):EVM 地址,public(明文落库、可导出重建)——
//
// **两个源共用这一份,所以它自己一个文件。** 它是 connector 的属性(这个账户怎么标识),
// 不是某个数据源的 —— 拆包前 rabby 包里还另有一份本地声明只为类型,那种「同一件事两处写」
// 正是这次拆包要消掉的。
export const evmAccountCreds = [
  {
    key: "address",
    type: "public",
    validator: z.string().regex(EVM_ADDRESS_RE, "expected 0x + 40 hex"),
    label: "EVM Address",
    desc: "0x + 40 hex",
  },
] as const satisfies readonly CredField[];
