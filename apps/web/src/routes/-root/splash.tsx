import { useRouterState } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { Logo } from "@/components/logo";
import { type Locale, messages } from "@/lib/i18n/messages";
import { useSplashUpdating } from "@/lib/pwa/service-worker";
import {
  SPLASH_EXIT_MS,
  SPLASH_MAX_MS,
  SPLASH_MIN_MS,
  type SplashPhase,
  splashPhase,
} from "./splash-lifecycle";

// Hides the page with visibility:hidden instead of covering it, so nothing can paint before the
// overlay (SSR streaming, iOS compositing, z-index races). Stays mounted: an update re-shows it.

const CONTENT_HIDDEN: CSSProperties = { visibility: "hidden" };

const LOCALES = Object.keys(messages) as Locale[];

// The static shell doesn't know the user's language yet, so render every locale and let
// SPLASH_STYLE show the one matching `<html lang>` (set before first paint).
function PreparingText() {
  return LOCALES.map((l) => (
    <span key={l} lang={l}>
      {messages[l].Splash.preparing}
    </span>
  ));
}

function messageKey(phase: SplashPhase): "preparing" | "loading" | "updating" {
  // exit has no message of its own; the last one stays during fade-out.
  return phase === "updating" ? "updating" : phase === "preparing" ? "preparing" : "loading";
}

export function SplashScreen({ children }: { children: ReactNode }) {
  const t = useTranslations("Splash");
  const routerIdle = useRouterState({ select: (s) => s.status === "idle" });
  const updating = useSplashUpdating();

  const [hydrated, setHydrated] = useState(false);
  const [minElapsed, setMinElapsed] = useState(false);
  const [maxElapsed, setMaxElapsed] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [released, setReleased] = useState(false);

  useEffect(() => {
    setHydrated(true);
    const min = setTimeout(() => setMinElapsed(true), SPLASH_MIN_MS);
    const max = setTimeout(() => setMaxElapsed(true), SPLASH_MAX_MS);
    return () => {
      clearTimeout(min);
      clearTimeout(max);
    };
  }, []);

  const phase = splashPhase({ hydrated, routerIdle, minElapsed, maxElapsed, updating });

  // Depend only on `phase` and guard with a ref: with `exiting` as a dep, setExiting re-ran the
  // effect, its cleanup cleared the release timer, and the overlay stayed up blocking clicks.
  const exitStarted = useRef(false);
  useEffect(() => {
    if (phase !== "exit" || exitStarted.current) return;
    exitStarted.current = true;
    setExiting(true);
    const timer = setTimeout(() => setReleased(true), SPLASH_EXIT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const lastMsg = useRef<"preparing" | "loading" | "updating">("preparing");
  if (phase !== "exit") lastMsg.current = messageKey(phase);
  const msg = lastMsg.current;

  // Reveal as the fade-out starts (cross-dissolve); stay hidden while updating until reload.
  const revealContent = (exiting || released) && !updating;
  const overlayMounted = !(released && !updating);

  return (
    <>
      <div id="app-content" style={revealContent ? undefined : CONTENT_HIDDEN}>
        {children}
      </div>
      {overlayMounted && (
        // No burst on the update path: just breathe until reload.
        <div
          id="app-splash"
          data-exit={exiting && !updating ? "true" : undefined}
          aria-hidden="true"
        >
          <Logo id="folio-splash-logo" />
          {/* No key remount: swapping text in place avoids a cold-start flash. */}
          <p id="folio-splash-msg">{hydrated ? t(msg) : <PreparingText />}</p>
        </div>
      )}
    </>
  );
}
