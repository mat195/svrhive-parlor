-- SVRHIVE Parlor — tables + email-scoped RLS.
--
-- Security model (Brief Two): every table's rows are visible/mutable ONLY to the
-- authenticated user whose JWT email matches the owner (Mat). Anon key WITHOUT a
-- session returns zero rows on every table (RLS on, no anon policy matches).
-- LLM/service keys never touch the browser — the silk-chat Edge Function (service
-- role) handles privileged work.

-- ---------------------------------------------------------------------------
-- Owner predicate. The ONLY email that can read/write through the anon key.
-- ---------------------------------------------------------------------------
create or replace function public.is_parlor_owner()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() ->> 'email') = 'matc195@gmail.com', false)
$$;

-- ---------------------------------------------------------------------------
-- New Parlor tables
-- ---------------------------------------------------------------------------
create table if not exists public.parlor_chats (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  title       text
);

create table if not exists public.parlor_messages (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references public.parlor_chats(id) on delete cascade,
  role        text not null check (role in ('user', 'assistant', 'system')),
  content     text not null,
  ledger_refs jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_parlor_messages_chat on public.parlor_messages (chat_id, created_at);

alter table public.parlor_chats    enable row level security;
alter table public.parlor_messages enable row level security;

-- Owner may read + create chats and rename them; messages are append-only.
create policy parlor_chats_select on public.parlor_chats for select to authenticated using (public.is_parlor_owner());
create policy parlor_chats_insert on public.parlor_chats for insert to authenticated with check (public.is_parlor_owner());
create policy parlor_chats_update on public.parlor_chats for update to authenticated using (public.is_parlor_owner()) with check (public.is_parlor_owner());

create policy parlor_messages_select on public.parlor_messages for select to authenticated using (public.is_parlor_owner());
create policy parlor_messages_insert on public.parlor_messages for insert to authenticated with check (public.is_parlor_owner());

-- ---------------------------------------------------------------------------
-- Ledger tables: grant the owner SELECT (read-only dashboards). No anon policy.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'visibility_runs','visibility_results','silk_journal','entity_facts',
    'link_graph','releases','tracks','mentions_ledger','metrics_snapshots','drafts'
  ]
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_parlor_owner());',
      t || '_owner_select', t
    );
  end loop;
end $$;

-- action_queue: owner may read AND update status (approve/reject). No delete.
create policy action_queue_owner_select on public.action_queue for select to authenticated using (public.is_parlor_owner());
create policy action_queue_owner_update on public.action_queue for update to authenticated using (public.is_parlor_owner()) with check (public.is_parlor_owner());
