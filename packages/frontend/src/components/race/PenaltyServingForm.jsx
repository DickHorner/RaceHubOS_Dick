import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PenaltyServingMethod } from '@racehubos/shared'
import { Button } from '@/components/ui/button'

export default function PenaltyServingForm({ penalty, session, disabled, onServe }) {
  const { t, i18n } = useTranslation('mobileControl')
  const [method, setMethod] = useState(PenaltyServingMethod.PIT)
  const [pitStopId, setPitStopId] = useState('')
  const [confirmed, setConfirmed] = useState(null)
  const [reason, setReason] = useState('')
  const stops = (session.pitStops || []).filter(
    (stop) =>
      stop.sessionDriverId === penalty.sessionDriverId &&
      stop.controller === penalty.controller &&
      stop.durationMs >= penalty.amount &&
      new Date(stop.enteredAt) >= new Date(penalty.issuedAt) &&
      !(session.penalties || []).some((row) => row.servedPitStopId === stop.id)
  )
  const selectedStop = stops.find((stop) => stop.id === pitStopId)?.id || stops[0]?.id || ''
  const isPit = method === PenaltyServingMethod.PIT
  const ready =
    reason.trim().length >= 3 && reason.trim().length <= 200 && (!isPit || (selectedStop && confirmed === selectedStop))
  const id = `serve-${penalty.id}`
  return (
    <form
      data-testid={id}
      className="space-y-2 rounded border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled && ready)
          onServe({
            method,
            pitStopId: isPit ? selectedStop : null,
            confirmedStationary: isPit && confirmed === selectedStop,
            reason: reason.trim(),
          })
      }}
    >
      <label className="block text-sm" htmlFor={`${id}-method`}>
        {t('penaltyServing.method')}
      </label>
      <select
        id={`${id}-method`}
        value={method}
        disabled={disabled}
        className="min-h-11 w-full rounded border bg-background p-2"
        onChange={(event) => {
          setMethod(event.target.value)
          setConfirmed(null)
        }}
      >
        <option value={PenaltyServingMethod.PIT}>{t('penaltyServing.pit')}</option>
        <option value={PenaltyServingMethod.MANUAL}>{t('penaltyServing.manual')}</option>
      </select>
      {isPit && (
        <>
          <label className="block text-sm" htmlFor={`${id}-stop`}>
            {t('penaltyServing.stop')}
          </label>
          <select
            id={`${id}-stop`}
            value={selectedStop}
            disabled={disabled || !stops.length}
            className="min-h-11 w-full rounded border bg-background p-2"
            onChange={(event) => {
              setPitStopId(event.target.value)
              setConfirmed(null)
            }}
          >
            {!stops.length && <option value="">{t('penaltyServing.noStop')}</option>}
            {stops.map((stop) => (
              <option key={stop.id} value={stop.id}>
                {new Date(stop.exitedAt).toLocaleString(i18n.language)} · {stop.durationMs / 1000} s ·{' '}
                {stop.source === 'simulator'
                  ? t('sessions:profile.pitStatus.source.simulator')
                  : t('sessions:profile.pitStatus.source.cu')}
              </option>
            ))}
          </select>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(selectedStop && confirmed === selectedStop)}
              disabled={disabled || !selectedStop}
              onChange={(event) => setConfirmed(event.target.checked ? selectedStop : null)}
            />
            {t('penaltyServing.confirm', { seconds: penalty.amount / 1000 })}
          </label>
        </>
      )}
      <label className="block text-sm" htmlFor={`${id}-reason`}>
        {t('penaltyServing.reason')}
      </label>
      <input
        id={`${id}-reason`}
        value={reason}
        maxLength={200}
        disabled={disabled}
        className="min-h-11 w-full rounded border bg-background p-2"
        onChange={(event) => setReason(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">{t('penaltyServing.help')}</p>
      <Button type="submit" disabled={disabled || !ready}>
        {t('penaltyServing.submit')}
      </Button>
    </form>
  )
}
