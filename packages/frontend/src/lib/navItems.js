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
} from 'lucide-react'

// labelKey resolves against the 'layout' namespace, unless `glossary: true`
// in which case it resolves against 'glossary' (plural form).
export const navGroups = [
  {
    labelKey: 'nav.areas.race',
    items: [
      { to: '/', labelKey: 'nav.dashboard', Icon: BarChart3 },
      { to: '/race', labelKey: 'nav.freeMode', Icon: Flag },
      { to: '/championships', labelKey: 'championship', glossary: true, Icon: Trophy },
      { to: '/display/control', labelKey: 'nav.raceControl', Icon: Gauge, standalone: true },
    ],
  },
  {
    labelKey: 'nav.areas.garage',
    items: [
      { to: '/cars', labelKey: 'car', glossary: true, Icon: Car },
      { to: '/drivers', labelKey: 'driver', glossary: true, Icon: Users },
      { to: '/teams', labelKey: 'team', glossary: true, Icon: Users2 },
      { to: '/tracks', labelKey: 'track', glossary: true, Icon: Map },
      { to: '/balancing', labelKey: 'nav.balancing', Icon: Scale },
    ],
  },
  {
    labelKey: 'nav.areas.show',
    items: [{ to: '/display/scoreboard', labelKey: 'nav.scoreboard', Icon: Monitor, standalone: true }],
  },
  {
    labelKey: 'nav.areas.analysis',
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

// Layout also resolves page titles from the same navigation data.
export const allNavItems = [...navGroups.flatMap((group) => group.items), ...systemNavItems]

// Resolves a nav item label. `t` must be a translation function bound to
// the 'layout' namespace (glossary items are resolved with an explicit ns).
export function navLabel(t, item) {
  return item.glossary ? t(item.labelKey, { ns: 'glossary', count: 2 }) : t(item.labelKey)
}
