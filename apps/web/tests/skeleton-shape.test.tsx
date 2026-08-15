import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HeroSkeleton, HoldingsSkeleton, OverviewSkeleton } from "../src/components/skeletons";

// 首页有两个骨架态:路由级(loader 返回前)与分区级(两块各自等自己的数据)。
// **两者必须逐像素同形** —— 一旦分头演化,过渡就从「淡入」变成「跳一下」,而那种位移在开发机上
// 几乎看不出来(数据太快),要到慢网上才现形。所以用「路由那份就是这两块拼起来的」把它钉死,
// 而不是各写一份再靠肉眼比对。
describe("首页骨架", () => {
  it("路由级骨架 = hero 骨架 + 持仓骨架,逐字相同", () => {
    const whole = render(<OverviewSkeleton />).container.innerHTML;
    const hero = render(<HeroSkeleton />).container.innerHTML;
    const holdings = render(<HoldingsSkeleton />).container.innerHTML;

    // 外层那个 flex 容器由路由那份自己提供,内容则必须原样是两块拼接。
    expect(whole).toContain(hero);
    expect(whole).toContain(holdings);
    expect(whole.indexOf(hero)).toBeLessThan(whole.indexOf(holdings));
  });
});
