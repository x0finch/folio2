# 底部抽屉自己写:档位用位移表达,不引 vaul

移动端的资产 / 账户抽屉靠 beUI vendored 的 `BottomSheet` 承载。它有三个毛病,而前两个是**同一个根因**:档位是靠改高度做的(`style={{ height: "60vh" }}` → `"92vh"`)。那是个普通的 React 内联 style,不在 `animate` 里 —— motion 不参与、浏览器也不补间,所以换档必然瞬间跳变。更要命的是 `dragElastic={{ top: 0.02 }}`:**向上基本拖不动**,你没法用手指把它从半档拉到全档,只能"甩"一下让它 teleport 过去 —— 手指和界面之间没有连续关系。第三个毛病独立:组件里**一处安全区都没有**,`0.92 * 100vh` 从底部量,顶边离屏顶只剩约 8vh,和灵动岛的 `safe-area-inset-top` 只差几个像素。

**所以自己写一个,放 `apps/web`,机制照 vaul:sheet 高度恒定,档位用 `translateY` 表达。** 顶格高度 `maxH = 100svh − env(safe-area-inset-top) − 余量`,两档 = `maxH` 的 60% 和 100% —— 灵动岛压不到是**结构上保证**的,不是靠 92% 这个数字凑出来。同一个位移值再驱动遮罩透明度和**背景缩小**(vaul 的 `shouldScaleBackground`,原生那种整屏往后收的观感),三者天然同步。

## 为什么不选另外三条

- **上 vaul。** 效果最好、最省力,但查过 npm:`vaul@1.1.2` 的 dependencies 只有一条 —— `@radix-ui/react-dialog`。而 [ADR 0004](0004-adopt-beui-motion-layer-drop-base-ui.md) 正是把 Radix / Base UI 请出去的那条决定。为一个抽屉把 Radix 请回整棵依赖树不划算,尤其是正确机制我们自己已经有一份能照的(见下)。
- **退成单档**(`snapPoints={["auto"]}`,组件本来就支持)。两行就能让跳变消失 —— 但它是靠**删掉功能**消失的,而且安全区那条还得拿一个小分数继续糊。
- **照 `Drawer` 写个"从底部"的简版,放弃多档。** 便宜(参照实现 90 行),但拿掉的正是这次要的东西:档位之间跟着手指连续移动。

## 照的是仓库里已有的那份

`packages/ui/src/components/motion/drawer.tsx`(beUI 的侧滑抽屉,90 行)**已经是对的机制** —— transform + spring,桌面那两处抽屉用的就是它、手感没人抱怨。它顶不上是因为只有左/右、没有任何拖拽,动画值写死是 `x` 且 `className` 改不动 `animate`。但它是最好的参照:把 `x` 换成 `y`,再补上跟手、按速度选档、安全区。beUI registry 里没有别的 sheet/drawer 件。

## 落地时几处不显然的地方

- **动画尽量交给 motion,别手写。** `motion@12.42.2` 的 `dragTransition` 收 `InertiaOptions`,里面的 `modifyTarget?: (v: number) => number` 文档原话就是「把自动算出的目标改掉,可用于对齐网格」。于是 motion 用它自己的衰减模型算出「照这个速度会滑到哪」(这就是 iOS 式投影,而 `power`/`timeConstant` 比手拍一个常数靠谱),我们只回答「离它最近的合法档位是哪个」。**动画本身、越界回弹、被下一次手势打断,全是 motion 的事** —— "动画中途反向拖不僵住"是白拿的。`dragMomentum` 要保持开着;关掉它就等于把惯性收回自己手里,那正是旧组件的做法。
- **dismiss 当成一个合法档位。** motion 没有"关闭"这个概念,但把"完全移出"的位移也放进档位数组,下甩就自然落到它 —— 手势和退场是同一条连续动画,不是两段。到位后靠 `y.on("animationComplete")`(motion value 自带这个事件)判位置再关。
- **背景缩放的 `transform` 必须开时加、关时彻底删掉(`none`)。** 任何非 `none` 的 transform 都让该元素成为 `position: fixed` 后代的**包含块** —— 这个坑仓库里已经踩过并写在 `portal.tsx` 的注释里。壳上一旦留下哪怕 `scale(1)`,壳内的移动 Dock 和非 portal 的全屏弹层(同步面板那个 `fixed inset-0 z-[80]`)就会退化成相对壳定位、随页面滚走。
- **Dock 会跟着背景一起缩,这是想要的** —— 原生就是整屏含底部栏一起往后收。sheet 自己、`MorphingModal`、toast 都 portal 到 body,所以都不受缩放影响。
- **壳里有两个 `backdrop-blur-xl`**(移动顶栏 + Dock),缩放它们的祖先会每帧重新栅格化。旧组件自己的注释就写过 backdrop-blur 在拖动时很贵。缓解办法是打开期间把这两处换成实色底,但**先实测再决定要不要上**。
- **旧的 vendored 件要连同 `packages/ui/src/index.ts` 的那行导出一起删掉**,否则 knip 判红(未用文件 + 未用导出)。这不算"改 vendored 件":它没人用了就该走。`Drawer` 不动 —— 桌面那两处还在用。
- **能测的只有策略,不是手感。** 把"档位 → 位移"和"投影 → 落哪档"抽成纯函数就能全分支覆盖;跟手手感、投影参数、缩放掉不掉帧只有真机能验,别拿绿的单测当做好了。
