import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <div className="p-8">
      <h1 className="text-4xl font-bold">Folio</h1>
      <p className="mt-4 text-lg">Self-hosted crypto portfolio tracker.</p>
    </div>
  )
}
