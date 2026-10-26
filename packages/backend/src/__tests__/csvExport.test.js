import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { buildSessionWorkbook } from '../lib/excelExport.js';
import { csvText, worksheetTableRows } from '../lib/csvExport.js';

describe('CSV export from workbook tables', () => {
  test('round-trips commas, quotes, line breaks, Unicode and empty values', async () => {
    const rows = [
      ['Name', 'Note', 'Lap'],
      ['Émilie, Jr.', 'Line one\n"Line two"', 8.5],
      ['車', '', null],
    ];
    const csv = csvText(rows);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"Émilie, Jr.","Line one\n""Line two""",8.5\r\n');

    const parsed = new ExcelJS.Workbook();
    await parsed.csv.read(Readable.from([csv]));
    const sheet = parsed.worksheets[0];
    expect(sheet.getRow(2).values.slice(1)).toEqual(['Émilie, Jr.', 'Line one\n"Line two"', 8.5]);
    expect(sheet.getRow(3).getCell(1).value).toBe('車');
    expect(sheet.getRow(3).getCell(3).value).toBeNull();
  });

  test('escapes spreadsheet formula-like user text without altering numeric values', () => {
    const csv = csvText([
      ['User', 'Points'],
      ['=HYPERLINK("https://bad.example")', -3],
      [' +SUM(1,2)', 4],
      ['@WEBSERVICE("x")', 5],
      ['-7', 6],
    ]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("' +SUM");
    expect(csv).toContain("'@WEBSERVICE");
    expect(csv).toContain("'-7");
    expect(csv).toContain(',-3\r\n');
  });

  test('uses the same results/laps as Excel, expressing times in seconds and dates in UTC', () => {
    const car = { id: 'car-1', brand: 'Audi', model: 'R8, GT', maxSpeed: 70, brakeForce: 50, fuelCapacity: 80 };
    const driver = { id: 'driver-1', name: '=SUM(1,2)', color: '#00ff00' };
    const session = {
      id: 'session-1',
      name: 'Tours',
      type: 'race',
      status: 'finished',
      fuelMode: 'OFF',
      track: { id: 'track-1', name: 'Monaco' },
      drivers: [
        {
          controller: 0,
          driverId: driver.id,
          carId: car.id,
          driver,
          car,
          gridPos: 1,
          finalPos: 1,
          totalLaps: 1,
          totalTime: 11_234,
          bestLapTime: 11_234,
          lastLapTime: 11_234,
        },
      ],
      laps: [
        {
          lapNumber: 1,
          controller: 0,
          driver,
          car,
          lapTime: 11_234,
          timestamp: new Date('2026-10-26T13:14:15.123Z'),
        },
      ],
    };
    const workbook = buildSessionWorkbook(session);
    const sheet = workbook.worksheets[1];
    const results = worksheetTableRows(sheet, 'Engagements');
    const laps = worksheetTableRows(sheet, 'Tours');

    expect(results[0]).toContain('Temps total (s)');
    expect(results[1][1]).toBe('=SUM(1,2)');
    expect(results[1][9]).toBe(11.234);
    expect(laps[0]).toContain('Horodatage (UTC ISO 8601)');
    expect(laps[1][4]).toBe(11.234);
    expect(laps[1][8]).toBe('2026-10-26T13:14:15.123Z');
    expect(csvText(results)).toContain("'=SUM(1,2)");
    expect(worksheetTableRows(sheet, 'Not a table')).toBeNull();
    const empty = buildSessionWorkbook({ ...session, laps: [], drivers: [] });
    const emptyLaps = worksheetTableRows(empty.worksheets[1], 'Tours');
    expect(emptyLaps).toHaveLength(1);
    expect(emptyLaps[0]).toContain('Temps (s)');
  });
});
