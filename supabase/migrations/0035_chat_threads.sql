-- Chat Stage B: threading + auto-archive. The Parlor already stores multiple parlor_chats;
-- this makes them first-class named threads (list-primary in the widget) and archives ones
-- that have gone quiet. Proactive Silk-initiated updates (the third Stage-B leg) already
-- shipped in 0034 (silk_notifications + widget badge).

alter table public.parlor_chats add column if not exists archived_at     timestamptz;
alter table public.parlor_chats add column if not exists last_message_at  timestamptz;

-- Backfill activity time from existing messages (fall back to created_at for empty chats).
update public.parlor_chats c
set last_message_at = coalesce(
  (select max(m.created_at) from public.parlor_messages m where m.chat_id = c.id),
  c.created_at)
where last_message_at is null;

-- Keep last_message_at fresh on every message, and un-archive a thread the moment it's
-- spoken in again (reopening an archived thread and sending revives it).
create or replace function public.touch_parlor_chat() returns trigger language plpgsql security definer as $$
begin
  update public.parlor_chats set last_message_at = now(), archived_at = null where id = new.chat_id;
  return new;
end $$;
drop trigger if exists trg_touch_parlor_chat on public.parlor_messages;
create trigger trg_touch_parlor_chat after insert on public.parlor_messages
  for each row execute function public.touch_parlor_chat();

-- Auto-archive threads idle > 24h. Outcomes were already distilled into chat_extractions by
-- the ambient conversation-distiller during the thread's life; here we record the archival +
-- opening context to the journal so there's a durable breadcrumb. Empty chats are skipped.
create or replace function public.archive_idle_chats() returns int language plpgsql security definer as $$
declare r record; n int := 0;
begin
  for r in
    select c.id,
           coalesce(nullif(c.title, ''), 'Silk chat') as title,
           (select count(*) from public.parlor_messages m where m.chat_id = c.id) as msgs,
           (select left(content, 120) from public.parlor_messages m where m.chat_id = c.id and role = 'user' order by created_at limit 1) as first_user
    from public.parlor_chats c
    where c.archived_at is null
      and c.last_message_at < now() - interval '24 hours'
      and exists (select 1 from public.parlor_messages m where m.chat_id = c.id)
  loop
    update public.parlor_chats set archived_at = now() where id = r.id;
    insert into public.silk_journal (entry, tags)
    values (
      format('Thread "%s" auto-archived after 24h idle (%s message(s)). Opened with: %s',
             r.title, r.msgs, coalesce(r.first_user, '—')),
      array['chat', 'archive']);
    n := n + 1;
  end loop;
  return n;
end $$;

select cron.schedule('chat_autoarchive', '15 * * * *', $$ select public.archive_idle_chats(); $$);
