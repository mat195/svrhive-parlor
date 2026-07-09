-- Proactive updates: Silk pushes to Mat (not just responds). Scheduled jobs and background
-- events write a notification here; the floating chat widget shows an unread badge + a
-- notifications list. The bar is "would Mat want to know this even if he's on another page
-- or away" — a finished battery, a blocked gate, a resolved stall, the morning briefing —
-- NOT routine tool calls.
create table if not exists public.silk_notifications (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,                 -- 'briefing' | 'battery' | 'gate-blocked' | 'stall' | 'job-done' | 'answer'
  title       text not null,                 -- short, plain-language headline
  body        text,                          -- what happened / what it means / what (if anything) Mat should do
  url         text,                          -- optional deep link (a live URL, a room)
  priority    text not null default 'normal' check (priority in ('normal', 'high')),
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_silk_notifications_unread on public.silk_notifications (created_at desc) where read_at is null;

alter table public.silk_notifications enable row level security;
drop policy if exists silk_notifications_owner_select on public.silk_notifications;
create policy silk_notifications_owner_select on public.silk_notifications for select to authenticated using (public.is_parlor_owner());
drop policy if exists silk_notifications_owner_update on public.silk_notifications;
create policy silk_notifications_owner_update on public.silk_notifications for update to authenticated using (public.is_parlor_owner()) with check (public.is_parlor_owner());

-- ── Daily briefing (10:30 UTC = 6:30am Montréal, 30min after workshop_initiative) ──
-- A real overnight synthesis: what moved in the battery, what's stalled, what's worth Mat's
-- 5 minutes today. Cheap (one Claude call), and the clearest proactive-contribution signal.
-- Runs just after workshop_initiative (10:00 UTC) so it can fold in the morning's proposals.
select cron.schedule(
  'daily_briefing',
  '30 10 * * *',
  $$
  select net.http_post(
    url := 'https://fitpvesrrirezbndkelo.supabase.co/functions/v1/daily-briefing',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_key')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── Battery-complete push (DB trigger) ───────────────────────────────────────
-- The battery is run outside the edge functions (local harvester / Action), so the reliable
-- hook is a trigger: any new visibility_runs row pushes a notification with the mention delta
-- vs the previous run. A drop is flagged high-priority. Catches the completion no matter how
-- the battery was launched.
create or replace function public.notify_battery_complete() returns trigger language plpgsql security definer as $$
declare prev_total int; delta int;
begin
  select mentions_total into prev_total from public.visibility_runs
    where run_at < new.run_at order by run_at desc limit 1;
  delta := new.mentions_total - coalesce(prev_total, new.mentions_total);
  insert into public.silk_notifications (kind, title, body, url, priority)
  values (
    'battery',
    'Battery: ' || new.mentions_total || '/' || new.prompt_count || ' mentions',
    case
      when prev_total is null then 'First battery run recorded.'
      when delta > 0 then 'Up ' || delta || ' mention(s) since the last run.'
      when delta < 0 then 'Down ' || abs(delta) || ' mention(s) since the last run — worth a look.'
      else 'Held steady vs the last run.'
    end,
    '#/brief',
    case when delta < 0 then 'high' else 'normal' end
  );
  return new;
end $$;
drop trigger if exists trg_notify_battery on public.visibility_runs;
create trigger trg_notify_battery after insert on public.visibility_runs
  for each row execute function public.notify_battery_complete();
