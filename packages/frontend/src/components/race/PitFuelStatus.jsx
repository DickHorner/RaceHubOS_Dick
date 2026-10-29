import { useTranslation } from 'react-i18next'

export default function PitFuelStatus({ session, sessionDriverId, entries = [] }) {
  const { t, i18n } = useTranslation('sessions')
  const belongs = (row) => !sessionDriverId || row.sessionDriverId === sessionDriverId
  const stops = (session.pitStops || []).filter(belongs)
  const refuels = (session.virtualFuelEvents || []).filter((event) => event.kind === 'refuel' && belongs(event))
  const drivers = (session.drivers || []).filter((row) => !sessionDriverId || row.id === sessionDriverId)
  const participant = (row) =>
    session.drivers?.find((driver) => driver.id === row.sessionDriverId)?.driver?.name ||
    t('profile.pitStatus.controller', { number: row.controller + 1 })

  return (
    <section data-testid="pit-fuel-status" className="rounded-xl border border-border bg-card p-5 space-y-4">
      <h2 className="font-semibold">{t('profile.pitStatus.title')}</h2>
      <p className="text-xs text-muted-foreground">{t('profile.pitStatus.note')}</p>
      <div data-testid="pit-fuel-levels" className="space-y-2">
        {session.virtualFuelRate == null ? (
          <p className="text-sm text-muted-foreground">{t('profile.pitStatus.off')}</p>
        ) : (
          <>
            <p className="text-sm">{t('profile.pitStatus.rate', { rate: session.virtualFuelRate })}</p>
            {drivers.map((driver) => {
              const live = entries.find((entry) => entry.id === driver.id && entry.controller === driver.controller)
              const units = live?.virtualFuelUnits ?? driver.virtualFuelUnits
              return (
                <p key={driver.id} className="text-sm font-semibold" data-testid={`pit-fuel-level-${driver.id}`}>
                  {driver.driver?.name || t('profile.pitStatus.controller', { number: driver.controller + 1 })}
                  {' · '}
                  {Number.isInteger(units)
                    ? t('profile.pitStatus.level', { percent: Math.round(units / 100) })
                    : t('profile.pitStatus.unavailable')}
                </p>
              )
            })}
          </>
        )}
      </div>
      <div>
        <h3 className="text-sm font-semibold" data-testid="pit-stop-count">
          {t('profile.pitHistory', { count: stops.length })}
        </h3>
        {stops.length === 0 && <p className="text-sm text-muted-foreground">{t('profile.pitStatus.noStops')}</p>}
        <ul className="divide-y divide-border">
          {stops.map((stop) => (
            <li key={stop.id} data-testid={`pit-stop-${stop.id}`} className="py-2 text-sm space-y-1">
              <p className="font-semibold break-words">{participant(stop)}</p>
              <p>
                {t(`profile.pitStatus.source.${stop.source}`, { defaultValue: t('profile.pitStatus.unknownSource') })}
              </p>
              <p className="text-xs text-muted-foreground">
                {new Date(stop.enteredAt).toLocaleString(i18n.language)} · ~{(stop.durationMs / 1000).toFixed(1)} s
              </p>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="text-sm font-semibold" data-testid="pit-refuel-count">
          {t('profile.pitStatus.refuels', { count: refuels.length })}
        </h3>
        {refuels.length === 0 && <p className="text-sm text-muted-foreground">{t('profile.pitStatus.noRefuels')}</p>}
        <ul className="divide-y divide-border">
          {refuels.map((event) => (
            <li key={event.id} data-testid={`pit-refuel-${event.id}`} className="py-2 text-sm space-y-1">
              <p className="font-semibold break-words">{participant(event)}</p>
              <p>{t('profile.pitStatus.refilled')}</p>
              <p>
                {t(`profile.pitStatus.source.${event.source}`, { defaultValue: t('profile.pitStatus.unknownSource') })}
              </p>
              <p className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString(i18n.language)}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
