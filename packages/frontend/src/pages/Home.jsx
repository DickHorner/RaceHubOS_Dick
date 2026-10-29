import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Flag } from 'lucide-react'
import { useSession } from '../context/SessionContext'
import { navGroups } from '../lib/navItems'

export default function Home() {
  const { t } = useTranslation('layout')
  const { session, isActive: isSessionActive } = useSession()

  return (
    <main className="mx-auto w-full max-w-6xl space-y-7 p-4 sm:p-7 lg:p-10">
      <header className="space-y-2">
        <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground">RaceHub OG</p>
        <h2 className="text-3xl font-black tracking-tight sm:text-4xl">{t('nav.homeTitle')}</h2>
        <p className="text-base text-muted-foreground">{t('nav.homeDescription')}</p>
      </header>

      {isSessionActive && (
        <Link
          to="/race"
          className="flex min-h-16 items-center gap-3 rounded-2xl border border-emerald-600/30 bg-emerald-100 p-4 font-semibold text-emerald-950 hover:bg-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100 dark:hover:bg-emerald-900"
        >
          <Flag className="size-6 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{session?.name || t('dashboard:activeSession.fallbackName')}</span>
          <span className="flex items-center gap-2">
            {t('dashboard:activeSession.join')}
            <ArrowRight className="size-5" />
          </span>
        </Link>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5">
        {navGroups.map((group) => (
          <Link
            key={group.id}
            to={group.to}
            data-testid={`area-tile-${group.id}`}
            className={`group relative flex min-h-56 items-center justify-between gap-2 overflow-hidden rounded-3xl border border-border p-5 text-foreground outline-none transition-colors hover:border-foreground/30 focus-visible:ring-4 focus-visible:ring-ring/50 sm:min-h-64 sm:p-7 ${group.tileClass}`}
          >
            <div className="relative z-10 flex max-w-[58%] flex-col items-start gap-3">
              <h3 className="text-xl font-black leading-tight sm:text-2xl">{t(group.labelKey)}</h3>
              <p className="text-sm leading-snug text-foreground/75 sm:text-base">
                {t(`nav.areaDescriptions.${group.id}`)}
              </p>
              <span className="mt-2 inline-flex items-center gap-1.5 text-sm font-bold">
                {t('nav.openArea')}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
              </span>
            </div>
            <img
              src={group.artwork}
              alt=""
              width="320"
              height="192"
              className="relative z-0 h-auto w-[42%] max-w-56 shrink-0 object-contain"
              decoding="async"
            />
          </Link>
        ))}
      </div>
    </main>
  )
}
