-- Risk classification on queue items. Every action_queue item carries a risk_tier
-- so Mat can triage at a glance and batch-approve zero-risk (green) items.
-- green: no external impact/reversible/private · amber: canonical/behavioral change ·
-- red: external state change (publishes/deploys) · grey: informational/Mat-decision-only.
alter table public.action_queue add column if not exists risk_tier text
  check (risk_tier in ('green', 'amber', 'red', 'grey'));
