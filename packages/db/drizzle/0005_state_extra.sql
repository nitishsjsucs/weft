-- Review fix (wave 2): the state certificate's extra withholding per period reaches payroll.
ALTER TABLE `tax_profiles` ADD `state_extra_cents` integer DEFAULT 0 NOT NULL;
