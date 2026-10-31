import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '../../components/PageHeader'

export const Route = createFileRoute('/_app/settings')({ component: SettingsPage })

function SettingsPage() {
  return <PageHeader title="Settings" subtitle="Display and account" />
}
