import { Link, Navigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, ExternalLink } from 'lucide-react'
import { navGroups, navLabel } from '../lib/navItems'

export default function AreaOverview() {
  const { areaId } = useParams()
  const { t } = useTranslation('layout')
  const group = navGroups.find((entry) => entry.id === areaId)

  if (!group) return <Navigate to="/" replace />

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-7 lg:p-10">
      <Link to="/" className="inline-flex items-center gap-2 text-sm font-semibold hover:underline">
        <ArrowLeft className="size-4" />
        {t('nav.backHome')}
      </Link>

      <header
        className={`flex items-center justify-between gap-3 rounded-3xl border border-border p-5 sm:p-8 ${group.tileClass}`}
      >
        <div className="max-w-[60%] space-y-2">
          <h2 className="text-2xl font-black tracking-tight sm:text-4xl">{t(group.labelKey)}</h2>
          <p className="text-sm text-foreground/75 sm:text-base">{t(`nav.areaDescriptions.${group.id}`)}</p>
        </div>
        <img src={group.artwork} alt="" width="320" height="192" className="w-[38%] max-w-60" />
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {group.items.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            target={item.standalone ? '_blank' : undefined}
            rel={item.standalone ? 'noopener noreferrer' : undefined}
            className="group flex min-h-28 items-center gap-4 rounded-2xl border border-border bg-card p-5 text-card-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted">
              <item.Icon className="size-6" />
            </span>
            <span className="min-w-0 flex-1 text-lg font-bold">{navLabel(t, item)}</span>
            {item.standalone ? (
              <ExternalLink className="size-5 shrink-0" aria-label={t('nav.newWindow')} />
            ) : (
              <ArrowRight className="size-5 shrink-0 transition-transform group-hover:translate-x-1" />
            )}
          </Link>
        ))}
      </div>
    </main>
  )
}
