import { Outlet, createFileRoute } from '@tanstack/react-router'

import { Shell } from '../app/Shell'

/** Pages inside the app shell. */
export const Route = createFileRoute('/_app')({ component: AppLayout })

function AppLayout() {
  return (
    <Shell>
      <Outlet />
    </Shell>
  )
}
