import type { ComponentProps } from "react";
import {
  AlertCircle as AlertCircleGlyph,
  AlertTriangle as AlertTriangleGlyph,
  Archive as ArchiveGlyph,
  ArrowLeft as ArrowLeftGlyph,
  Bell as BellGlyph,
  ChartBar as ChartBarGlyph,
  CheckCircle as CheckCircleGlyph,
  Check as CheckGlyph,
  ChevronDown as ChevronDownGlyph,
  ChevronLeft as ChevronLeftGlyph,
  ChevronRight as ChevronRightGlyph,
  Edit as EditGlyph,
  Fingerprint as FingerprintGlyph,
  FolderMove as FolderMoveGlyph,
  HelpCircle as HelpCircleGlyph,
  Home as HomeGlyph,
  InfoCircle as InfoCircleGlyph,
  ListCheck as ListCheckGlyph,
  Loader as LoaderGlyph,
  Logout as LogoutGlyph,
  Monitor as MonitorGlyph,
  Moon as MoonGlyph,
  More as MoreGlyph,
  MoreH as MoreHGlyph,
  Pin as PinGlyph,
  Plus as PlusGlyph,
  Receipt as ReceiptGlyph,
  Record as RecordGlyph,
  Refresh as RefreshGlyph,
  Reply as ReplyGlyph,
  SearchMinus as SearchMinusGlyph,
  Settings as SettingsGlyph,
  Sliders as SlidersGlyph,
  Stickynote as StickynoteGlyph,
  Sun as SunGlyph,
  Tag as TagGlyph,
  Trash as TrashGlyph,
  Wallet as WalletGlyph,
  Xmark as XmarkGlyph,
} from "reicon-react";
import { cn } from "./lib/utils";

// DESIGN.md: an 18px glyph with a 1.5px line, centred in a transparent 24px box.
const GLYPH_PX = 18;
// Reicon's stroke width is in 24px-grid units and scales with the glyph: 2 renders 1.5px at 18px.
const STROKE_ON_GRID = 2;

type Glyph = typeof CheckGlyph;
// `size` / `strokeWidth` are accepted and ignored: vendored beUI parts pass them, the box is fixed.
export type IconProps = ComponentProps<"span"> & { size?: number; strokeWidth?: number };
export type Icon = (props: IconProps) => React.JSX.Element;

const boxed = (Glyph: Glyph): Icon =>
  function BoxedIcon({ className, size: _size, strokeWidth: _strokeWidth, ...rest }: IconProps) {
    return (
      <span
        aria-hidden="true"
        className={cn("inline-flex size-6 shrink-0 items-center justify-center", className)}
        {...rest}
      >
        <Glyph size={GLYPH_PX} strokeWidth={STROKE_ON_GRID} />
      </span>
    );
  };

export const AlertCircle = boxed(AlertCircleGlyph);
export const AlertTriangle = boxed(AlertTriangleGlyph);
export const Archive = boxed(ArchiveGlyph);
export const ArrowLeft = boxed(ArrowLeftGlyph);
export const BarChart3 = boxed(ChartBarGlyph);
export const Bell = boxed(BellGlyph);
export const Check = boxed(CheckGlyph);
export const ChevronDown = boxed(ChevronDownGlyph);
export const ChevronLeft = boxed(ChevronLeftGlyph);
export const ChevronRight = boxed(ChevronRightGlyph);
export const Circle = boxed(RecordGlyph);
export const CircleAlert = boxed(AlertCircleGlyph);
export const CircleCheck = boxed(CheckCircleGlyph);
export const CircleHelp = boxed(HelpCircleGlyph);
export const CornerDownLeft = boxed(ReplyGlyph);
export const Ellipsis = boxed(MoreHGlyph);
export const Fingerprint = boxed(FingerprintGlyph);
export const FolderInput = boxed(FolderMoveGlyph);
export const Home = boxed(HomeGlyph);
export const Info = boxed(InfoCircleGlyph);
export const ListChecks = boxed(ListCheckGlyph);
export const Loader2 = boxed(LoaderGlyph);
export const LoaderCircle = boxed(LoaderGlyph);
export const LogOut = boxed(LogoutGlyph);
export const Monitor = boxed(MonitorGlyph);
export const Moon = boxed(MoonGlyph);
export const MoreVertical = boxed(MoreGlyph);
export const Pencil = boxed(EditGlyph);
export const Pin = boxed(PinGlyph);
export const Plus = boxed(PlusGlyph);
export const Receipt = boxed(ReceiptGlyph);
export const RefreshCw = boxed(RefreshGlyph);
export const SearchX = boxed(SearchMinusGlyph);
export const Settings = boxed(SettingsGlyph);
export const Settings2 = boxed(SlidersGlyph);
export const StickyNote = boxed(StickynoteGlyph);
export const Sun = boxed(SunGlyph);
export const Tag = boxed(TagGlyph);
export const Trash2 = boxed(TrashGlyph);
export const TriangleAlert = boxed(AlertTriangleGlyph);
export const Wallet = boxed(WalletGlyph);
export const X = boxed(XmarkGlyph);
