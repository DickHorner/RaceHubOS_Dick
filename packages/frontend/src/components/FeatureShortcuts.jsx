import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowRight } from 'lucide-react'
import { featureShortcuts } from '../lib/navItems'

export default function FeatureShortcuts({ area }) {
  const { t } = useTranslation('layout')
  const items = featureShortcuts.filter((item) => !area || item.area === area)
  if (!items.length) return null
  return (
    <section data-testid="feature-shortcuts" className="space-y-3" aria-label={t('features.title')}>
      <h2 className="text-xl font-bold">{t('features.title')}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <Link
            key={item.id}
            to={item.to}
            data-testid={`feature-${item.id}`}
            className="rounded-xl border border-border bg-card p-4 space-y-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <h3 className="flex items-center justify-between gap-2 font-semibold">
              {t(`features.${item.id}.title`)}
              <ArrowRight className="size-4 shrink-0" />
            </h3>
            <p className="text-sm">{t(`features.${item.id}.description`)}</p>
            <p className="text-xs text-muted-foreground">{t(`features.${item.id}.requires`)}</p>
          </Link>
        ))}
      </div>
    </section>
  )
}
