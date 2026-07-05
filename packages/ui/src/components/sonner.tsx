import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// 跟随本 app 的深色策略(<html>.dark 类,见 apps/web lib/theme),不依赖 next-themes。
function useHtmlTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("light")
  useEffect(() => {
    const el = document.documentElement
    const update = () => setTheme(el.classList.contains("dark") ? "dark" : "light")
    update()
    const obs = new MutationObserver(update)
    obs.observe(el, { attributes: true, attributeFilter: ["class"] })
    return () => obs.disconnect()
  }, [])
  return theme
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useHtmlTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
