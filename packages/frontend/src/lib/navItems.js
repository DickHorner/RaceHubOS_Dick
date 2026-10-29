import {
  BarChart3,
  Flag,
  Trophy,
  Clock,
  Users,
  Car,
  Map,
  Users2,
  LayoutGrid,
  Scale,
  Terminal,
  Settings,
  Gauge,
  Monitor,
  House,
} from 'lucide-react'

// The four areas supply both the landing tiles and the sidebar destinations.
export const navGroups = [
  {
    id: 'race',
    to: '/areas/race',
    labelKey: 'nav.areas.race',
    Icon: Flag,
    artwork: '/illustrations/race.svg',
    tileClass: 'bg-orange-100 dark:bg-orange-950/50',
    items: [
      { to: '/dashboard', labelKey: 'nav.dashboard', Icon: BarChart3 },
      { to: '/race', labelKey: 'nav.freeMode', Icon: Flag },
      { to: '/championships', labelKey: 'championship', glossary: true, Icon: Trophy },
      { to: '/display/control', labelKey: 'nav.raceControl', Icon: Gauge, standalone: true },
    ],
  },
  {
    id: 'garage',
    to: '/areas/garage',
    labelKey: 'nav.areas.garage',
    Icon: Car,
    artwork: '/illustrations/garage.svg',
    tileClass: 'bg-emerald-100 dark:bg-emerald-950/50',
    items: [
      { to: '/cars', labelKey: 'car', glossary: true, Icon: Car },
      { to: '/drivers', labelKey: 'driver', glossary: true, Icon: Users },
      { to: '/teams', labelKey: 'team', glossary: true, Icon: Users2 },
      { to: '/tracks', labelKey: 'track', glossary: true, Icon: Map },
      { to: '/balancing', labelKey: 'nav.balancing', Icon: Scale },
    ],
  },
  {
    id: 'show',
    to: '/areas/show',
    labelKey: 'nav.areas.show',
    Icon: Monitor,
    artwork: '/illustrations/show.svg',
    tileClass: 'bg-violet-100 dark:bg-violet-950/50',
    items: [{ to: '/display/scoreboard', labelKey: 'nav.scoreboard', Icon: Monitor, standalone: true }],
  },
  {
    id: 'analysis',
    to: '/areas/analysis',
    labelKey: 'nav.areas.analysis',
    Icon: BarChart3,
    artwork: '/illustrations/analysis.svg',
    tileClass: 'bg-sky-100 dark:bg-sky-950/50',
    items: [
      { to: '/history', labelKey: 'nav.history', Icon: Clock },
      { to: '/stats', labelKey: 'nav.stats', Icon: BarChart3 },
    ],
  },
]

export const systemNavItems = [
  { to: '/settings', labelKey: 'nav.settings', Icon: Settings },
  { to: '/displays', labelKey: 'nav.displays', Icon: LayoutGrid, adminOnly: true },
  { to: '/test', labelKey: 'nav.test', Icon: Terminal, adminOnly: true },
]

// Layout resolves page titles from the same navigation data.
export const allNavItems = [
  { to: '/', labelKey: 'nav.home', Icon: House },
  ...navGroups,
  ...navGroups.flatMap((group) => group.items),
  ...systemNavItems,
]

// labelKey resolves against layout, or against glossary for plural entities.
export function navLabel(t, item) {
  return item.glossary ? t(item.labelKey, { ns: 'glossary', count: 2 }) : t(item.labelKey)
}
