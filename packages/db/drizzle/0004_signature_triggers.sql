-- Review fix (wave 2): e-signature records are tamper-evident. A signature row never changes or goes away, and a
-- signed document's text and hash are frozen. Only POST /v1/sim/reset rebuilds them, by recreating the database file.
CREATE TRIGGER `signatures_no_update` BEFORE UPDATE ON `signatures` BEGIN SELECT RAISE(ABORT, 'signatures is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `signatures_no_delete` BEFORE DELETE ON `signatures` BEGIN SELECT RAISE(ABORT, 'signatures is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `documents_signed_no_edit` BEFORE UPDATE OF `body_text`, `sha256` ON `documents` WHEN OLD.`status` = 'signed' BEGIN SELECT RAISE(ABORT, 'a signed document is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `documents_signed_no_delete` BEFORE DELETE ON `documents` WHEN OLD.`status` = 'signed' BEGIN SELECT RAISE(ABORT, 'a signed document is immutable'); END;
