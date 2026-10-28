import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { Button } from '@/components/ui/button'

const API_URL = import.meta.env.VITE_API_URL || ''

export default function LanShareLink({ path, inputId, directorKey = '' }) {
  const { t } = useTranslation('lanShare')
  const [addresses, setAddresses] = useState([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState(false)
  const [includeKey, setIncludeKey] = useState(false)
  const [enteredKey, setEnteredKey] = useState('')

  useEffect(() => {
    let active = true
    fetch(`${API_URL}/api/race-control/lan-addresses`)
      .then((response) => {
        if (!response.ok) throw new Error('LAN address request failed')
        return response.json()
      })
      .then((result) => {
        if (!result.success || !Array.isArray(result.data)) throw new Error('Invalid LAN addresses')
        const available = result.data.filter(
          (entry) =>
            typeof entry?.name === 'string' &&
            typeof entry.address === 'string' &&
            /^(?:10|172|192)\.(?:\d{1,3}\.){2}\d{1,3}$/.test(entry.address)
        )
        if (!active) return
        setAddresses(available)
        const current = available.find((entry) => entry.address === window.location.hostname)
        setSelected(current?.address || (available.length === 1 ? available[0].address : ''))
      })
      .catch(() => {
        if (active) setError(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const address = addresses.find((entry) => entry.address === selected)?.address
  const isDirector = path === '/display/control'
  const credential = directorKey || enteredKey.trim()
  const keyReady = !includeKey || credential.length >= 32
  const url = address && keyReady ? new URL(path, window.location.origin) : null
  if (url) {
    url.hostname = address
    if (isDirector && includeKey) url.hash = new URLSearchParams({ director: credential }).toString()
  }
  const link = url?.href || ''

  async function copy() {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      window.prompt(t('manualCopy'), link)
    }
  }

  if (loading)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {t('loading')}
      </p>
    )
  if (error)
    return (
      <p role="alert" className="text-xs text-destructive">
        {t('unavailable')}
      </p>
    )
  if (!addresses.length)
    return (
      <p role="alert" className="text-xs text-destructive">
        {t('noLan')}
      </p>
    )

  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="lan-share-panel">
      {addresses.length > 1 && (
        <label className="flex flex-wrap items-center gap-2 text-xs">
          {t('address')}
          <select
            className="rounded-md border bg-background p-1"
            aria-label={t('address')}
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value)
              setCopied(false)
            }}
          >
            <option value="">{t('chooseAddress')}</option>
            {addresses.map((entry) => (
              <option key={entry.address} value={entry.address}>
                {entry.name} · {entry.address}
              </option>
            ))}
          </select>
        </label>
      )}
      {isDirector && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={includeKey}
              onChange={(event) => {
                setIncludeKey(event.target.checked)
                setCopied(false)
              }}
            />
            {t('includeKey')}
          </label>
          {includeKey && !directorKey && (
            <input
              type="password"
              autoComplete="off"
              aria-label={t('directorKey')}
              placeholder={t('directorKey')}
              className="w-full rounded-md border bg-background p-2 text-sm"
              value={enteredKey}
              onChange={(event) => setEnteredKey(event.target.value)}
            />
          )}
          {includeKey && <p className="text-xs text-amber-600">{t('keyWarning')}</p>}
        </div>
      )}
      {link ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="inline-flex w-fit rounded bg-white p-2" data-testid="lan-share-qr">
            <QRCodeSVG value={link} size={176} marginSize={2} level="M" title={t('qrLabel')} />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="block break-all text-sm text-primary underline underline-offset-2"
            >
              {includeKey ? `${url.origin}${url.pathname}#director=••••` : link}
            </a>
            <input
              id={inputId}
              aria-label={t('link')}
              type={includeKey ? 'password' : 'text'}
              className="w-full rounded-md border bg-background p-2 font-mono text-xs"
              readOnly
              value={link}
              onFocus={(event) => event.target.select()}
            />
            <Button type="button" size="sm" variant="outline" onClick={copy}>
              {copied ? t('copied') : t('copy')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('lanHint')}</p>
          </div>
        </div>
      ) : (
        <p role="status" className="text-xs text-muted-foreground">
          {address && !keyReady ? t('keyRequired') : t('chooseAddress')}
        </p>
      )}
    </div>
  )
}
