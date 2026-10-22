/**
 * One CSV cell. Quotes values containing separators, and neutralises spreadsheet formulas: a cell
 * starting with = + - @ (or a tab/CR) would otherwise be executed when the file is opened in Excel.
 */
export function csvCell(value: unknown): string {
  let s =
    value === null || value === undefined
      ? ""
      : value instanceof Date
        ? value.toISOString()
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",");
