import { EASE_IN_OUT } from "@folio/ui/lib/ease";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { Children, createContext, type ReactNode, useContext, useEffect } from "react";

// 进场编排(FOL-79 续):页面主体那几段内容依次淡入 + 轻抬(10px → 0),一段接一段。
//
// 为什么不整页淡入:整页 opacity 0→1 在 0.26s / EASE_OUT 下前 78ms 就走完约 87%,揭开后第一帧
// 已经接近不透明 —— 测出来确实在动,但看着就是「啪」一下。逐段错开 + 温和曲线才看得见「进场」。
//
// **只动 opacity 与 y,绝不动 scale / filter**:带 transform(或 filter)的层会变成后代绝对定位元素的
// 包含块,而页头那个 `<HeaderSync/>` 是 absolute 定位到外壳 `<main>` 的 —— 一旦被这层裹住,同步条会
// 整体顶跳约 24px / 左移 16px(老坑)。所以 `HeaderSync` 由各页渲染在本容器**之外**:它是每页都一样的
// 常驻壳件,不参与进场才是对的。y 的静止值精确为 0,motion 此时写的是 `transform: none`,持仓页那条
// `sticky` 小额条照旧工作。
const RISE_PX = 10;
const ITEM_DURATION = 0.35;
const STAGGER = 0.055;
const DELAY_CHILDREN = 0.04;

const CONTAINER_VARIANTS = {
  hidden: {},
  visible: { transition: { delayChildren: DELAY_CHILDREN, staggerChildren: STAGGER } },
} as const;

const ITEM_VARIANTS = {
  hidden: { opacity: 0, y: RISE_PX },
  visible: { opacity: 1, y: 0, transition: { duration: ITEM_DURATION, ease: EASE_IN_OUT } },
} as const;

// 「该重播进场了」的信号:由 `Panel` 在本页由隐藏转为当前页时递增(见 index.tsx)。不在 provider 里
// 就恒为 0 —— 那时只靠挂载播一次,也是对的。
export const RevealContext = createContext(0);

// 把直接子节点各裹一层 motion.div 作为错列单元。`className` 由页面传(通常是它原来那件
// `flex flex-col gap-*`),所以插入这层容器对布局是中性的;`itemClassName` 给「一整段内容其实是一个
// 子节点(如外面还套着一层数据边界)」的页面用,把竖排间距挪到单元上,间距不变。
export function StaggerReveal({
  children,
  className,
  itemClassName,
}: {
  children: ReactNode;
  className?: string;
  itemClassName?: string;
}) {
  const reveal = useContext(RevealContext);
  const controls = useAnimationControls();
  const reduce = useReducedMotion();
  // 挂载时播一遍,之后每次 `reveal` 变化(本页又成为当前页)重播一遍。不靠换 key 重挂载 ——
  // 那会把页面状态(滚动、展开、抽屉)一起清掉,保活就白做了。`set("hidden")` 会沿 variantChildren
  // 递归下去,所以归零与起播都只需对容器说一次。`reveal` 只当扳机、effect 里不读它:
  // biome-ignore lint/correctness/useExhaustiveDependencies: reveal 是重播扳机,不在 effect 里读
  useEffect(() => {
    if (reduce) {
      controls.set("visible");
      return;
    }
    controls.set("hidden");
    controls.start("visible");
  }, [reveal, reduce, controls]);
  // `initial` 首帧就藏住,进场因此从 0 起、不闪一帧全不透明;声明了减弱动效则首帧直接是终态。
  return (
    <motion.div
      className={className}
      variants={CONTAINER_VARIANTS}
      initial={reduce ? "visible" : "hidden"}
      animate={controls}
    >
      {Children.map(children, (child) => (
        <motion.div className={itemClassName} variants={ITEM_VARIANTS}>
          {child}
        </motion.div>
      ))}
    </motion.div>
  );
}
