-- Append-only audit tables (SPEC 6.5, harness 6.5). Only POST /v1/sim/reset rebuilds them, by recreating the database file.
CREATE TRIGGER `actions_no_update` BEFORE UPDATE ON `actions` BEGIN SELECT RAISE(ABORT, 'actions is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `actions_no_delete` BEFORE DELETE ON `actions` BEGIN SELECT RAISE(ABORT, 'actions is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `approval_audit_no_update` BEFORE UPDATE ON `approval_audit` BEGIN SELECT RAISE(ABORT, 'approval_audit is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `approval_audit_no_delete` BEFORE DELETE ON `approval_audit` BEGIN SELECT RAISE(ABORT, 'approval_audit is append-only'); END;
