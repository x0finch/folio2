import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '../../components/PageHeader'

export const Route = createFileRoute('/_app/insights')({ component: InsightsPage })

function InsightsPage() {
  return <PageHeader title="Insights" subtitle="History and allocation over time" />
}
