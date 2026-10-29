import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, AudioLines } from 'lucide-react'
import Soundboard from '../components/race/Soundboard'

export default function SoundboardOperator() {
  const { t } = useTranslation('soundboard')

  return (
    <main className="min-h-dvh bg-background px-4 py-5 text-foreground sm:px-8 sm:py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-primary/10 p-3 text-primary">
                <AudioLines className="size-7" aria-hidden="true" />
              </div>
              <h1 className="text-3xl font-black tracking-tight sm:text-4xl">{t('title')}</h1>
            </div>
            <p className="max-w-xl text-sm text-muted-foreground sm:text-base">{t('operatorHint')}</p>
          </div>
          <Link
            to="/race"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-semibold hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <ArrowLeft className="size-4" aria-hidden="true" /> {t('backToRace')}
          </Link>
        </header>
        <Soundboard operatorOnly />
      </div>
    </main>
  )
}
