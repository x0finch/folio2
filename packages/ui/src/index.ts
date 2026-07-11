// @folio/ui —— shadcn 组件,具名 re-export(用到一个加一个,保持引入面最小)。

export {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "./components/avatar";
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/card";
export {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
  ChartTooltip,
  ChartTooltipContent,
} from "./components/chart";
export { Fab, fabVariants } from "./components/fab";
export { Label } from "./components/label";
export { LogoAvatar } from "./components/logo-avatar";
export { AnimatedBadge, AnimatedBadge as Badge } from "./components/motion/animated-badge";
export {
  BouncyAccordion,
  type BouncyAccordionItem,
  type BouncyAccordionProps,
} from "./components/motion/bouncy-accordion";
export { Button, buttonVariants, StatefulButton } from "./components/motion/button";
export { Checkbox } from "./components/motion/checkbox";
export { CommandPalette } from "./components/motion/command-palette";
export { Dock, DockItem, DockSeparator } from "./components/motion/dock";
export { Drawer } from "./components/motion/drawer";
export { Input } from "./components/motion/input";
export { NumberTicker } from "./components/motion/number-ticker";
export {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/motion/select";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/motion/tabs";
export { Toaster, toast } from "./components/motion/toast";
export { Tooltip } from "./components/motion/tooltip";
export { Separator } from "./components/separator";
export { Skeleton } from "./components/skeleton";
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/table";
export { cn } from "./lib/utils";
