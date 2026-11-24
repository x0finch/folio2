import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Mounts into <body> to escape ancestor transform/overflow containing blocks (BottomSheet's
// permanent transform would clip fixed overlays such as MorphingModal). Renders nothing before mount.
export function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
