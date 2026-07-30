/**
 * Closed diagnostic enum for ADB read-only inspection.
 *
 * Diagnostics are exposed to the MCP layer only as a fixed enum — never as a
 * raw token or command field. Each enum value maps to a fixed token array in
 * {@link buildAdbCommand}. Adding a diagnostic requires extending both this
 * list and the command builder; a caller can never synthesize one.
 */

export const ADB_DIAGNOSTIC_KINDS = [
  "getprop_subset",
  "dumpsys_package",
  "dumpsys_activity",
  "pm_path",
  "df_data",
  "pidof_package",
] as const;

export type AdbDiagnosticKind = (typeof ADB_DIAGNOSTIC_KINDS)[number];

const ALLOWED = new Set<string>(ADB_DIAGNOSTIC_KINDS);

export function isAllowedDiagnosticKind(value: string): value is AdbDiagnosticKind {
  return ALLOWED.has(value);
}
