import { ChartColumn, House, Settings, Wallet } from 'lucide-react'

/** The app's main destinations, shared by the sidebar and the mobile dock. */
export const NAV = [
  { to: '/', label: 'Overview', icon: House },
  { to: '/accounts', label: 'Accounts', icon: Wallet },
  { to: '/insights', label: 'Insights', icon: ChartColumn },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const
