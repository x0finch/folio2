import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '../../components/PageHeader'

export const Route = createFileRoute('/_app/')({ component: OverviewPage })

function OverviewPage() {
  return <PageHeader title="Overview" subtitle="Your portfolio at a glance" />
}
