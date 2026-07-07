# 采用 beUI 动效层,弃用 Base UI

Status: accepted(已实施 —— `@base-ui/react` 已移除,beUI 件全部落地)

UI 从「纯 base-vega(Base UI)shadcn 栈」转为「**beUI(Framer Motion)动效层 + 少量手搓原语**」,经 `@beui/*` shadcn registry 分发。beUI 有的组件(Tabs/Tooltip/Select/Button/Toast/Drawer/Input/Badge/Checkbox)全部替换为 beUI 版;beUI 没有的(Card/Avatar/Separator/Skeleton)手搓成十来行本地件;Combobox → fork Command Palette,Sidebar → beUI 导航(顶栏 + 底部 Dock)。净效果:**移除 `@base-ui/react` 依赖**。beUI 随件附带的 `lib/ease.ts`(spring/easing token)升为全站 canonical 动效基线。

起因:手搓的 base-vega 层被证明脆弱(细线 tab 下划线实测 `::after opacity:0` 从不渲染),且产品要「全动效、demo 级」的独特观感 —— beUI 提供 Base UI 所无的成品 spring 动效组件。

## Considered Options

1. 留 base-vega、手工修组件 —— 否:脆弱且不独特。
2. base-vega + beUI 混合栈 —— 否:为一致性,收紧为「零 shadcn」。
3. 全 beUI + 手搓补齐 —— **选中**。

## Consequences

- 新增 Framer Motion(`motion`)运行时依赖(bundle 成本)。
- beUI 组件带 `"use client"`:非 RSC 下无害,但 SSR / CF Workers 的 hydration 须在 B0 的 Tabs spike 实测。
- 拷贝式(copy-paste)= 我们自持并维护落地的 beUI 源码。
- Command Palette 须 fork 以支持远程 token 搜索 + 回填价;选币从「表单内嵌字段」变为「⌘K 模态」。
- 应用外壳重设计(顶栏 + Dock),弃用常驻左侧栏及其 off-canvas 机制。
- 失去 Base UI 内建的无障碍原语 —— 手搓/fork 的组件须自行承担 a11y(键盘导航、aria、focus 管理)。
