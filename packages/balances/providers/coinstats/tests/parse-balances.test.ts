import { describe, expect, it } from "vitest";
import { parseBalances } from "../src";
import fixture from "./fixtures/balances.json";
import expected from "./fixtures/expected-balances.json";

// 两份 fixture 一一对应:balances.json(录制的真实 wallet/balance 响应,解析器输入)→
// expected-balances.json(解析后的结构化期望值,固化在文件里逐一对比,不散写在断言里)。
// 覆盖:value=amount*price、kind=spot、链无关映射(Solana/Sui/Cosmos)、每条 coin 自带 chain、
// null price→0、原生币(无 contract)→无 tokenIdentifier、跳过无 symbol。
// JSON 无法表达 undefined → expected 省略未定义字段(toEqual 视缺键与 undefined 等价);
// 非整数乘积(CT/ATOM)在 fixture 里以位级相等的十进制字面量固化。
describe("parseBalances (golden: fixture in → fixture out)", () => {
  const balances = parseBalances(fixture, "solana");

  it("maps the recorded response to expected-balances", () => {
    expect(balances).toEqual(expected);
  });

  it("excludes the no-symbol entry", () => {
    // fixture 有 7 条,其中 1 条 symbol 为空 → 解析结果与 expected 同长,且无空 symbol。
    expect(balances).toHaveLength(expected.length);
    expect(balances.every((b) => b.symbol.length > 0)).toBe(true);
  });
});
