import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { publicResultRows, publicResultHtml } from '../../lib/publicResults'

export default function PublicResultExport({ entries, isRace, simulatedTotal, simulatedBest }) {
  const { t, i18n } = useTranslation('sessions')
  const [includeNames, setIncludeNames] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const model = {
    title: t('publicExport.title'),
    lang: i18n.resolvedLanguage || i18n.language,
    note: t('publicExport.artifactNote'),
    columns: [
      t('printResults.position'),
      t('printResults.driver'),
      t('printResults.laps'),
      t('printResults.bestLap'),
      ...(simulatedBest ? [t('printResults.simulatedBest')] : []),
      ...(isRace ? [t(simulatedTotal ? 'race:leaderboard.simulatedTotal' : 'printResults.totalTime')] : []),
    ],
    rows: publicResultRows(entries, {
      includeNames,
      isRace,
      simulatedTotal,
      simulatedBest,
      driverLabel: (number) => t('publicExport.driver', { number }),
    }),
  }

  function download() {
    if (!reviewed) return
    const href = URL.createObjectURL(new Blob([publicResultHtml(model)], { type: 'text/html;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = href
    link.download = 'racehub-results.html'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(href)
  }

  return (
    <section
      data-testid="public-result-export"
      className="my-6 space-y-4 rounded-xl border border-border bg-card p-5 print:hidden"
    >
      <h2 className="text-lg font-bold">{t('publicExport.title')}</h2>
      <p className="text-sm">{t('publicExport.description')}</p>
      <label className="flex min-h-12 items-center gap-3">
        <input
          type="checkbox"
          checked={includeNames}
          onChange={(event) => {
            setIncludeNames(event.target.checked)
            setReviewed(false)
          }}
        />
        {t('publicExport.includeNames')}
      </label>
      <p className="text-sm text-muted-foreground">{t('publicExport.excluded')}</p>
      <div data-testid="public-result-preview" className="overflow-x-auto">
        <h3 className="font-semibold">{t('publicExport.preview')}</h3>
        <p className="my-2 text-sm">{model.note}</p>
        <table className="w-full text-sm">
          <thead>
            <tr>
              {model.columns.map((column) => (
                <th key={column} scope="col" className="p-2 text-left">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column} className="border-t border-border p-2">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm">{t('publicExport.hosting')}</p>
      <label className="flex min-h-12 items-center gap-3">
        <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />
        {t('publicExport.reviewed')}
      </label>
      <Button onClick={download} disabled={!reviewed}>
        {t('publicExport.download')}
      </Button>
    </section>
  )
}
