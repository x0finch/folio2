import { tokenRef } from "@folio/oracle-ref";
import { tokenTicket } from "@folio/oracle2";
import { NAMER } from "../../src/lib/server/internal/oracle2";

// 选币下拉发给前端的那张票 = base64url 编过的 tokenRef。**测试里现编,与生产同一个编码器** ——
// 手写 base64 字面量的话,编码规则一改测试就静默失配。
//
// 五个手记集成测试各写过一遍这个助手,收成一处:它们对「选了币」的表达必须一致,
// 而各写一遍的代价刚被证实过 —— 其中三处停在了 ticket 之前的旧写法(直接塞 `identifier`,
// 那个字段早就没人读了),于是「选了币」这件事全靠 mint 按 symbol 猜出来,#223 一收紧就集体变红。
export const ticketOf = (coinId: string) => tokenTicket.encode(tokenRef.issued(NAMER, coinId));
