/**
 * Creates any missing tab on the CRM spreadsheet and writes its header row.
 *
 * Every reader in `GoogleSheetStore` addresses a hardcoded range (`orders!A:U`,
 * `b2cs!A:F`, …) and Sheets answers HTTP 400 `Unable to parse range` for a tab that
 * doesn't exist — so on a fresh spreadsheet the first fulfillment webhook, the first
 * delivery and the first B2CS run all 500 rather than degrading. Every reader also
 * does `values.slice(1)` to skip the header, so a tab created without one silently
 * loses its first record. This script is what makes both impossible.
 *
 * Idempotent: a tab that already exists is left exactly as it is, header included.
 * Row 1 is derived from the same header constants the adapters use — never retyped —
 * because `listLedger` maps columns onto names positionally off `LEDGER_HEADERS`, so
 * a hand-typed header in a different order would silently mislabel every ledger read.
 *
 * Usage: SHEET_ID=… npm run setup:sheets
 *
 * Authenticates with Application Default Credentials, exactly as the running service
 * does — `gcloud auth application-default login`, or a service account whose email
 * the sheet is shared with as an Editor.
 */
import { google } from 'googleapis';
import {
  B2CS_HEADERS,
  EFFECT_HEADERS,
  EVENT_HEADERS,
  INVOICE_HEADERS,
  MESSAGE_HEADERS,
  ORDER_HEADERS,
  SHIPMENT_HEADERS,
} from '../src/adapters/sheets.js';
import { LEDGER_HEADERS } from '../src/core/ledgerRow.js';

const sheetId = process.env.SHEET_ID;
if (!sheetId) {
  console.error('Usage: SHEET_ID=your-spreadsheet-id npm run setup:sheets');
  process.exit(1);
}

/** Tab title → its header row. The titles are the ones the adapter's ranges name. */
const TABS: Array<{ title: string; headers: readonly string[] }> = [
  { title: 'orders', headers: ORDER_HEADERS },
  { title: 'messages', headers: MESSAGE_HEADERS },
  { title: 'events', headers: EVENT_HEADERS },
  { title: 'shipments', headers: SHIPMENT_HEADERS },
  { title: 'invoices', headers: INVOICE_HEADERS },
  { title: 'effects', headers: EFFECT_HEADERS },
  // A–Y, including the operator's own R–V block: the hub never writes those columns,
  // but the operator fills them in by hand and needs them labelled.
  { title: 'ledger', headers: LEDGER_HEADERS },
  { title: 'b2cs', headers: B2CS_HEADERS },
];

const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const meta = await sheets.spreadsheets.get({
  spreadsheetId: sheetId,
  fields: 'properties.title,sheets.properties.title',
});

const existing = new Set(
  (meta.data.sheets ?? [])
    .map((sheet) => sheet.properties?.title)
    .filter((title): title is string => typeof title === 'string'),
);

console.log(`Spreadsheet: ${meta.data.properties?.title ?? sheetId}`);
for (const tab of TABS) {
  if (existing.has(tab.title)) console.log(`  exists  ${tab.title}`);
}

const missing = TABS.filter((tab) => !existing.has(tab.title));
if (missing.length === 0) {
  console.log('\nAll eight tabs already exist — nothing to do.');
  process.exit(0);
}

await sheets.spreadsheets.batchUpdate({
  spreadsheetId: sheetId,
  requestBody: {
    requests: missing.map((tab) => ({
      addSheet: {
        properties: { title: tab.title, gridProperties: { frozenRowCount: 1 } },
      },
    })),
  },
});

// RAW, never USER_ENTERED: a header is a literal string, and USER_ENTERED is reserved
// for the ledger's W–Y formulas alone.
await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: sheetId,
  requestBody: {
    valueInputOption: 'RAW',
    data: missing.map((tab) => ({
      range: `${tab.title}!A1`,
      values: [[...tab.headers]],
    })),
  },
});

for (const tab of missing) {
  console.log(`  created ${tab.title} (${tab.headers.length} columns)`);
}
console.log(`\nCreated ${missing.length} tab(s). Re-running this is safe.`);
