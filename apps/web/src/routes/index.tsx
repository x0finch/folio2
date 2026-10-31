import { APP_NAME } from '@folio/shared'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <h1 className="text-2xl font-semibold">{APP_NAME}</h1>
    </div>
  )
}
