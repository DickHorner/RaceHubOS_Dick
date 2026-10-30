import { useTranslation } from 'react-i18next'
import Soundboard from '../components/race/Soundboard'

export default function SoundboardSettings() {
  const { t } = useTranslation('soundboard')

  return (
    <section
      aria-labelledby="soundboard-settings-title"
      className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-7 lg:p-10"
    >
      <header className="space-y-2">
        <h2 id="soundboard-settings-title" className="text-2xl font-black tracking-tight sm:text-4xl">
          {t('layout:nav.soundboardSettings')}
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">{t('managementHint')}</p>
      </header>
      <Soundboard defaultOpen />
    </section>
  )
}
