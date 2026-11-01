// Whitelist display values only; never serialize the source session/driver objects.
export function publicResultRows(
  entries,
  { includeNames = false, isRace, simulatedTotal, simulatedBest, driverLabel }
) {
  const time = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return '–'
    const minutes = Math.floor(ms / 60000)
    return `${minutes}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`
  }
  return entries.map((entry, index) => [
    entry.isDNF ? 'DNF' : String(index + 1),
    includeNames && entry.driver?.name ? entry.driver.name : driverLabel(index + 1),
    String(isRace ? entry.classifiedLaps : (entry.totalLaps ?? 0)),
    time(entry.bestLapTime),
    ...(simulatedBest ? [time(entry.simulatedBestLapTime)] : []),
    ...(isRace ? [time(simulatedTotal ? entry.classifiedSimulatedTime : entry.classifiedTime)] : []),
  ])
}

export function publicResultHtml({ title, columns, rows, note, lang }) {
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    )
  return `<!doctype html><html lang="${escape(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>body{font:16px system-ui,sans-serif;margin:2rem;color:#18202a;background:#fff}table{border-collapse:collapse;width:100%}th,td{padding:.7rem;text-align:left;border-bottom:1px solid #aaa}p{max-width:70ch}</style></head><body><h1>${escape(title)}</h1><p>${escape(note)}</p><table><thead><tr>${columns.map((column) => `<th scope="col">${escape(column)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`
}
