import { EASE_IN_OUT } from "@folio/ui/lib/ease";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { Children, createContext, type ReactNode, useContext, useEffect } from "react";

// Sections of a page fade in and rise (10px -> 0) one after another. Not a whole-page fade: that
// reaches ~87% opacity in the first 78ms and looks like a pop.
// Only opacity and y, never scale / filter: a transformed layer becomes the containing block for
// absolutely positioned descendants, and `<HeaderSync/>` is absolute against the shell `<main>`;
// wrapping it would shift the sync bar. So pages render HeaderSync outside this container. y rests
// at exactly 0 (`transform: none`) so the holdings page's `sticky` bar still works.
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

// Bumped by `Panel` when this page becomes current again (see index.tsx); 0 outside a provider.
export const RevealContext = createContext(0);

// Wraps each direct child in a motion.div as a stagger unit. `itemClassName` is for pages whose
// whole content is one child (e.g. inside a data boundary): the vertical gap moves onto the unit.
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
  // Plays on mount and on every `reveal` change. No key-remount: that would wipe page state
  // (scroll, expanded, drawers). `set("hidden")` recurses via variantChildren, so one call to the
  // container resets and starts everything. `reveal` is only a trigger, not read in the effect:
  // biome-ignore lint/correctness/useExhaustiveDependencies: reveal is a replay trigger, not read in the effect
  useEffect(() => {
    if (reduce) {
      controls.set("visible");
      return;
    }
    controls.set("hidden");
    controls.start("visible");
  }, [reveal, reduce, controls]);
  // `initial` hides the first frame so the entrance starts from 0; reduced motion starts at the final state.
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
