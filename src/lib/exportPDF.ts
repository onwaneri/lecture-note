// Compatibility shim — the export pipeline lives in `exportPDFv2.ts` (pdf-lib
// based, produces a real text layer). Existing call sites import from this
// file; re-exporting keeps the import paths stable.
export { exportInterleavedPDF, type ExportOptions } from './exportPDFv2'
