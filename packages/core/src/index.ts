export * from "./shared/index";
export { commands } from "./commands/index";
export { handlers } from "./handlers/index";
export * as payroll from "./payroll/index";
export * as offboarding from "./offboarding/cases";
export * as expenses from "./expenses/index";   // wave 3 (w3-expenses)
export * as lifeEvents from "./life-events/index";   // wave 4 (w4-parity-people)
export { complianceNoticeVariant } from "./compliance/script-variant";   // wave 4 (w4-parity-compliance), the scripted variant chooser
export * from "./demo/index";
export { REPORT_CATALOG, type CatalogEntry } from "./commands/w4-admin";   // wave 4 (w4-parity-admin): the Reports screen catalog
