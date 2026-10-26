import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Copy, Printer } from 'lucide-react'
import { SessionStatus, SessionType, rankRaceDrivers } from '@racehubos/shared'
import { Button } from '@/components/ui/button'
import LapTime from '../components/race/LapTime'

const API_URL = import.meta.env.VITE_API_URL || ''

export default function SessionResults() {
  const { sessionId } = useParams()
  const { t, i18n } = useTranslation('sessions')
  const [loaded, setLoaded] = useState(null)
  const [copiedSessionId, setCopiedSessionId] = useState(null)
  const loading = loaded?.id !== sessionId
  const session = loading ? null : loaded.data

  useEffect(() => {
    let cancelled = false
    fetch(`${API_URL}/api/sessions/${sessionId}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Session not found')
        const result = await response.json()
        if (!result.success) throw new Error(result.error || 'Session not found')
        return result.data
      })
      .then((data) => {
        if (!cancelled) setLoaded({ id: sessionId, data })
      })
      .catch((error) => {
        console.error('Error loading printable results:', error)
        if (!cancelled) setLoaded({ id: sessionId, data: null })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  async function copyLink() {
    const link = window.location.href
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      window.prompt(`${t('printResults.manualCopy')} ${t('printResults.lanHint')}`, link)
      return
    }
    try {
      await navigator.clipboard.writeText(link)
      setCopiedSessionId(sessionId)
    } catch {
      window.prompt(t('printResults.manualCopy'), link)
    }
  }

  const printable =
    session?.status === SessionStatus.FINISHED && [SessionType.RACE, SessionType.QUALIF].includes(session.type)
  const isRace = session?.type === SessionType.RACE
  const drivers = (session?.drivers || []).filter((entry) => !entry.deletedAt)
  const rows = isRace
    ? rankRaceDrivers(drivers, session?.penalties || [])
    : [...drivers].sort((a, b) => {
        const aBest = a.bestLapTime > 0 ? a.bestLapTime : Infinity
        const bBest = b.bestLapTime > 0 ? b.bestLapTime : Infinity
        return aBest === bBest ? a.controller - b.controller : aBest - bBest
      })

  const date = (value) => (value ? new Date(value).toLocaleString(i18n.language) : '–')

  return (
    <main className="min-h-dvh bg-background text-foreground print:bg-white print:text-black">
      <div className="mx-auto max-w-5xl p-4 sm:p-8 print:max-w-none print:p-0">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
          <Button variant="outline" asChild>
            <Link to={`/sessions/${sessionId}`}>
              <ArrowLeft className="size-4" /> {t('common:back')}
            </Link>
          </Button>
          {printable && (
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={copyLink}>
                <Copy className="size-4" /> {t('printResults.copyLink')}
              </Button>
              <Button onClick={() => window.print()}>
                <Printer className="size-4" /> {t('printResults.print')}
              </Button>
            </div>
          )}
        </div>

        {loading ? (
          <p role="status">{t('printResults.loading')}</p>
        ) : !session ? (
          <p role="alert">{t('profile.notFound')}</p>
        ) : !printable ? (
          <p role="status">{t('printResults.onlyFinished')}</p>
        ) : (
          <article className="space-y-6">
            <header className="space-y-3 border-b border-border pb-5 print:border-gray-400">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground print:text-gray-600">
                RaceHubOS · {t('printResults.title')}
              </p>
              <h1 className="text-2xl font-bold">
                {session.name || t('unnamedSession', { id: session.id.slice(0, 8) })}
              </h1>
              <p className="text-sm text-muted-foreground print:text-gray-600">
                {t(`glossary:sessionTypeFull.${session.type}`, { defaultValue: session.type })} ·{' '}
                {t(`glossary:sessionStatus.${session.status}`, { defaultValue: session.status })}
              </p>
              <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 print:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground print:text-gray-600">{t('printResults.track')}</dt>
                  <dd className="font-semibold">{session.track?.name || '–'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground print:text-gray-600">{t('printResults.championship')}</dt>
                  <dd>{session.championship?.name || '–'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground print:text-gray-600">{t('printResults.started')}</dt>
                  <dd>{date(session.startedAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground print:text-gray-600">{t('printResults.finished')}</dt>
                  <dd>{date(session.finishedAt)}</dd>
                </div>
              </dl>
            </header>

            <section aria-label={t('printResults.standings')} className="space-y-3">
              <h2 className="text-lg font-bold">{t('printResults.standings')}</h2>
              {rows.length === 0 ? (
                <p>{t('profile.noParticipants')}</p>
              ) : (
                <div className="overflow-x-auto print:overflow-visible">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead className="border-b-2 border-border print:border-gray-600">
                      <tr>
                        <th className="p-2">{t('printResults.position')}</th>
                        <th className="p-2">{t('printResults.driver')}</th>
                        <th className="p-2">{t('printResults.car')}</th>
                        <th className="p-2 text-right">{t('printResults.laps')}</th>
                        <th className="p-2 text-right">{t('printResults.bestLap')}</th>
                        {isRace && <th className="p-2 text-right">{t('printResults.totalTime')}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((entry, index) => (
                        <tr key={entry.id} className="break-inside-avoid border-b border-border print:border-gray-300">
                          <td className="p-2 font-semibold">{entry.isDNF ? 'DNF' : index + 1}</td>
                          <td className="p-2">{entry.driver?.name || `Ctrl ${entry.controller + 1}`}</td>
                          <td className="p-2">
                            {[entry.car?.brand, entry.car?.model].filter(Boolean).join(' ') || '–'}
                          </td>
                          <td className="p-2 text-right tabular-nums">
                            {isRace ? entry.classifiedLaps : (entry.totalLaps ?? 0)}
                          </td>
                          <td className="p-2 text-right">
                            <LapTime time={entry.bestLapTime} size="sm" className="print:text-black" />
                          </td>
                          {isRace && (
                            <td className="p-2 text-right">
                              <LapTime
                                time={
                                  session.tyreMismatchPercent > 0 ? entry.classifiedSimulatedTime : entry.classifiedTime
                                }
                                format="total"
                                size="sm"
                                className="print:text-black"
                              />
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {isRace && (
                <p className="text-xs text-muted-foreground print:text-gray-600">
                  {t('printResults.classificationNote')}
                </p>
              )}
            </section>

            <footer className="border-t border-border pt-3 text-xs text-muted-foreground print:border-gray-400 print:text-gray-600">
              {t('printResults.source')}: RaceHubOS · {t('printResults.sessionId')}: {session.id}
            </footer>
            <p className="text-xs text-muted-foreground print:hidden" role="note">
              {t('printResults.lanHint')}
            </p>
            {copiedSessionId === sessionId && (
              <p role="status" className="text-sm text-green-600 print:hidden">
                {t('printResults.linkCopied')}
              </p>
            )}
          </article>
        )}
      </div>
    </main>
  )
}
