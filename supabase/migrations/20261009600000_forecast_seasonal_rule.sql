-- Budget & forecast: a `seasonal` rule — a 12-month profile by calendar month, repeated with optional
-- year-on-year growth. It is what the rule suggester proposes for an account whose history has a
-- shape (payroll with a December bonus, a quarterly-heavy marketing spend) that no single fixed,
-- recurring or run-rate rule describes.
--
-- Widening the allowed set only, so it is safe to apply before or after the release that writes it.

alter table public.forecast_rules drop constraint if exists forecast_rules_method_check;
alter table public.forecast_rules add constraint forecast_rules_method_check
  check (method in ('manual', 'fixed', 'recurring', 'run_rate', 'growth', 'seasonal', 'linked_fee', 'linked_construction'));
