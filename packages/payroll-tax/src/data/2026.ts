// Versioned rate data (SPEC 7.1, research/domain.md section 6, version 2026.1). Owner: t1-payroll. Synthetic tables.
export const TAX_DATA_VERSION = "2026.1";
export interface TaxTables { version: string; [key: string]: unknown }
export const TAX_2026: TaxTables = { version: TAX_DATA_VERSION };
