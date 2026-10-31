import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Outlet, createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { LogOut } from 'lucide-react'

import { Shell } from '../app/Shell'
import { meQuery, signOut } from '../features/auth/auth'

/** Pages inside the app shell; signed-out visitors go to sign-in. */
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context }) => {
    if (typeof window === 'undefined') return
    if (!(await context.queryClient.ensureQueryData(meQuery))) throw redirect({ to: '/sign-in' })
  },
  component: AppLayout,
})

function AppLayout() {
  return (
    <Shell account={<AccountChip />}>
      <Outlet />
    </Shell>
  )
}

function AccountChip() {
  const { data: me } = useQuery(meQuery)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  if (!me) return null

  async function leave() {
    await signOut()
    queryClient.clear()
    await navigate({ to: '/sign-in' })
  }

  return (
    <div className="flex items-center gap-2">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium uppercase">
        {me.email.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm" title={me.email}>
        {me.name}
      </span>
      <button
        type="button"
        onClick={() => void leave()}
        aria-label="Sign out"
        title="Sign out"
        className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <LogOut className="size-4" />
      </button>
    </div>
  )
}
