import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SessionStatus, SessionType } from '@racehubos/shared'
import { analyzeSessionLaps } from '../../lib/lapAnalysis'

export default function SessionLapChart({ session }) {
  const { t, i18n } = useTranslation('sessions')
  const { series, chartData, leaders, incomplete, sampled } = useMemo(() => analyzeSessionLaps(session), [session])
  const [hidden, setHidden] = useState([])
  const selected = series.filter((item) => !hidden.includes(item.controller))
  const selectedKeys = new Set(selected.map((item) => item.key))
  const record = session.track?.bestLap > 0 ? session.track.bestLap / 1000 : null
  const visibleLeaders = leaders.slice(-50)

  if (!series.length) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t('lapAnalysis.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('lapAnalysis.seriesFilter')}</legend>
          <div className="flex flex-wrap gap-3">
            {series.map((item) => (
              <label key={item.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedKeys.has(item.key)}
                  onChange={() =>
                    setHidden((previous) =>
                      previous.includes(item.controller)
                        ? previous.filter((controller) => controller !== item.controller)
                        : [...previous, item.controller]
                    )
                  }
                />
                <span className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                <span>{item.driverName} · {item.carName || t('lapAnalysis.carUnknown')}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {selected.length ? (
          <div aria-label={t('lapAnalysis.chartLabel')} className="w-full">
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartData} margin={{ top: 12, right: 20, bottom: 20, left: 5 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis
                  dataKey="lap"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tick={{ fontSize: 12 }}
                  label={{ value: t('lapAnalysis.lap'), position: 'insideBottomRight', offset: -5 }}
                />
                <YAxis
                  domain={['auto', 'auto']}
                  tick={{ fontSize: 12 }}
                  tickFormatter={(value) => value.toFixed(1)}
                  label={{ value: t('lapAnalysis.seconds'), angle: -90, position: 'insideLeft' }}
                />
                <Tooltip
                  labelFormatter={(lap) => t('lapAnalysis.lapLabel', { lap })}
                  formatter={(value, key) => [
                    t('lapAnalysis.timeValue', { value: Number(value).toFixed(3) }),
                    selected.find((entry) => entry.key === key)?.driverName || key,
                  ]}
                />
                {record !== null && (
                  <ReferenceLine y={record} stroke="#7c3aed" strokeDasharray="5 5" />
                )}
                {selected.map((item) => (
                  <Line
                    key={item.key}
                    dataKey={item.key}
                    type="linear"
                    stroke={item.color}
                    strokeWidth={2}
                    connectNulls={false}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
                {selected.map((item) => (
                  <ReferenceDot
                    key={`best-${item.key}`}
                    x={item.bestLapNumber}
                    y={item.bestLapTime}
                    fill={item.color}
                    stroke="#fff"
                    r={5}
                    isFront
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
            {record !== null && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('lapAnalysis.trackRecord', { seconds: record.toFixed(3) })}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t('lapAnalysis.bestMarkers')}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('lapAnalysis.noSeries')}</p>
        )}

        {sampled && (
          <p className="text-xs text-muted-foreground">{t('lapAnalysis.sampled')}</p>
        )}

        {session.type === SessionType.RACE && session.status === SessionStatus.FINISHED && (
          <section className="border-t border-border pt-4 space-y-2">
            <h3 className="text-sm font-semibold">{t('lapAnalysis.leadTitle')}</h3>
            <p className="text-xs text-muted-foreground">{t('lapAnalysis.leadCaveat')}</p>
            {incomplete ? (
              <p role="status" className="text-sm text-amber-600">{t('lapAnalysis.uncertain')}</p>
            ) : leaders.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('lapAnalysis.noLeader')}</p>
            ) : (
              <>
                {leaders.length > visibleLeaders.length && (
                  <p className="text-xs text-muted-foreground">
                    {t('lapAnalysis.lastEvents', { count: visibleLeaders.length })}
                  </p>
                )}
                <ol className="max-h-64 overflow-auto space-y-1 text-sm">
                  {visibleLeaders.map((event) => {
                    const item = series.find((row) => row.controller === event.controller)
                    return (
                      <li key={`${event.controller}-${event.lapNumber}`}>
                        {event.type === 'first' ? t('lapAnalysis.firstLeader') : t('lapAnalysis.leadChange')}
                        {' · '}{item?.driverName || `Ctrl ${event.controller + 1}`}
                        {' · '}{t('lapAnalysis.lapLabel', { lap: event.lapNumber })}
                        {' · '}{new Date(event.timestamp).toLocaleTimeString(i18n.language)}
                      </li>
                    )
                  })}
                </ol>
                {!leaders.some((event) => event.type === 'change') && (
                  <p className="text-xs text-muted-foreground">{t('lapAnalysis.noChanges')}</p>
                )}
              </>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  )
}
