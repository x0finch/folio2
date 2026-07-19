import { describe, expect, it } from "vitest";
import { CONNECTOR_ICON } from "../src/lib/connector-icons";
import { CONNECTOR_OPTIONS } from "../src/lib/connectors";

// 唯一新增纯缝(A4):添加账户网格的每个 Connector 都得有图标。CONNECTOR_OPTIONS 是网格实际渲染的源(展平即
// 全部格子);断言其每一项在 CONNECTOR_ICON 里有条目 —— 将来新增 connector 却漏配图标时,网格会渲染无图标格,
// 此测先红。(Record<ConnectorId> 已给编译期穷尽;这条守的是 CONNECTOR_OPTIONS 列表与图标表不漂移。)
describe("CONNECTOR_ICON 覆盖网格全部 Connector", () => {
  const gridConnectors = CONNECTOR_OPTIONS.flatMap((g) => g.options);

  it("网格里每个 connector 都有图标", () => {
    const missing = gridConnectors.filter((id) => CONNECTOR_ICON[id] == null);
    expect(missing).toEqual([]);
  });

  it("图标都是可渲染的组件(函数/对象)", () => {
    for (const id of gridConnectors) {
      const Icon = CONNECTOR_ICON[id];
      expect(["function", "object"]).toContain(typeof Icon);
    }
  });
});
