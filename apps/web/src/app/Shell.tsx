import { Dock, DockItem } from '@folio/ui/components/motion/dock'
import { Link, useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { Logo } from '../components/Logo'
import { NAV } from './nav'
import { ThemeToggle } from './ThemeToggle'

function isActive(pathname: string, to: string) {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`)
}

/**
 * The signed-in layout: a sidebar on wide screens; a top bar and a floating dock on phones.
 * `account` sits at the foot of the sidebar (and in settings on phones).
 */
export function Shell({ children, account }: { children: ReactNode; account?: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-card/40 px-3 py-5 md:flex">
        <Link to="/" className="px-3">
          <Logo />
        </Link>
        <nav className="mt-8 flex flex-col gap-1" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              data-active={isActive(pathname, to) || undefined}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[active]:bg-muted data-[active]:font-medium data-[active]:text-foreground"
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex items-center justify-between gap-2 px-1">
          <div className="min-w-0 flex-1">{account}</div>
          <ThemeToggle />
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-background/80 px-4 py-3 backdrop-blur md:hidden">
        <Link to="/">
          <Logo />
        </Link>
        <ThemeToggle />
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 pt-8 pb-32 md:px-10 md:pt-12 md:pb-16">
        {children}
      </main>

      <nav
        className="fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 flex justify-center md:hidden"
        aria-label="Main"
      >
        <Dock size={48}>
          {NAV.map(({ to, label, icon: Icon }) => (
            <DockItem key={to} active={isActive(pathname, to)}>
              <Link to={to} aria-label={label} className="grid size-full place-items-center">
                <Icon className="size-5" />
              </Link>
            </DockItem>
          ))}
        </Dock>
      </nav>
    </div>
  )
}
