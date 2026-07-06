-- Brief Six: Conversational Memory. Every Mat↔Silk chat exchange becomes
-- permanent structured memory via the conversation-distiller. Extractions batch
-- into chat_extractions for Mat's one-pass approval, then cascade like answers do.

create table if not exists public.chat_extractions (
  id               uuid primary key default gen_random_uuid(),
  chat_id          uuid references public.parlor_chats(id) on delete cascade,
  message_ids      jsonb not null default '[]'::jsonb,   -- source messages (provenance)
  extraction_type  text not null check (extraction_type in ('fact','preference','correction','instinct','question')),
  proposed_content jsonb not null,                        -- {summary, canonical, target_field, ...}
  target_field     text,                                  -- entity-master section / table / doctrine
  provenance       jsonb not null default '{}'::jsonb,    -- {source, chat_id, message_ids, quote, at}
  confidence       text not null default 'needs-review' check (confidence in ('verified','unverified','needs-review')),
  supersedes       jsonb,                                 -- {field, old_value, new_value} when it contradicts canon; null otherwise
  status           text not null default 'pending' check (status in ('pending','approved','rejected','superseded')),
  resolved_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists idx_chat_extractions_status on public.chat_extractions (status, created_at desc);
create index if not exists idx_chat_extractions_chat on public.chat_extractions (chat_id);

create table if not exists public.conversation_distiller_runs (
  id                        uuid primary key default gen_random_uuid(),
  chat_id                   uuid references public.parlor_chats(id) on delete cascade,
  distilled_through_message_id uuid,        -- checkpoint: last message covered
  distilled_through_at      timestamptz,    -- its created_at (cheap high-water mark)
  ran_at                    timestamptz not null default now(),
  extraction_count          int not null default 0,
  notes                     text
);
create index if not exists idx_distiller_runs_chat on public.conversation_distiller_runs (chat_id, ran_at desc);

alter table public.chat_extractions enable row level security;
alter table public.conversation_distiller_runs enable row level security;
create policy chat_extractions_owner on public.chat_extractions for select to authenticated using (public.is_parlor_owner());
create policy chat_extractions_owner_upd on public.chat_extractions for update to authenticated using (public.is_parlor_owner()) with check (public.is_parlor_owner());
create policy distiller_runs_owner on public.conversation_distiller_runs for select to authenticated using (public.is_parlor_owner());
