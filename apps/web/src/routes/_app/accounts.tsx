import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '../../components/PageHeader'

export const Route = createFileRoute('/_app/accounts')({ component: AccountsPage })

function AccountsPage() {
  return <PageHeader title="Accounts" subtitle="Manage your data sources" />
}
