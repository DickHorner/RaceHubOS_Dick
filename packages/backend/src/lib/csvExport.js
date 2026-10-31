import { DURATION_FORMAT } from './excelExport.js';

/** Select one table from an existing Excel worksheet; CSV cannot contain multiple sheets. */
export function worksheetTableRows(sheet, heading) {
  let headingRow;
  sheet.eachRow((row, number) => {
    if (row.getCell(1).value === heading) headingRow = number;
  });
  if (!headingRow) return null;

  const header = sheet.getRow(headingRow + 2);
  const width = header.cellCount;
  const rows = [
    Array.from({ length: width }, (_, index) => {
      const label = String(header.getCell(index + 1).value ?? '');
      if (
        [
          'Temps total',
          'Meilleur tour',
          'Dernier tour',
          'Temps',
          'Temps simulé',
          'Temps total simulé',
          'Meilleur tour simulé',
          'S1',
          'S2',
          'S3',
        ].includes(label)
      ) {
        return `${label} (s)`;
      }
      if (label === 'Horodatage') return `${label} (UTC ISO 8601)`;
      return label;
    }),
  ];

  for (let index = headingRow + 3; index <= sheet.rowCount; index++) {
    const cells = Array.from({ length: width }, (_, column) => sheet.getRow(index).getCell(column + 1));
    if (cells.every((cell) => cell.value == null || cell.value === '')) break;
    rows.push(
      cells.map((cell) => {
        if (cell.value instanceof Date) return cell.value.toISOString();
        if (cell.numFmt === DURATION_FORMAT && typeof cell.value === 'number') {
          return Number((cell.value * 86_400).toFixed(3));
        }
        return cell.value ?? '';
      })
    );
  }

  return rows;
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Spreadsheet programs may evaluate untrusted text beginning with a formula token.
  // A real numeric value stays numeric; only strings are escaped.
  if (typeof value === 'string' && /^[\s\uFEFF\u200B]*[=+\-@]/u.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
  return text;
}

/** Deterministic UTF-8 with BOM, RFC 4180 quoting and CRLF line endings. */
export function csvText(rows) {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function sendCsv(res, fileName, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.end(csvText(rows));
}
