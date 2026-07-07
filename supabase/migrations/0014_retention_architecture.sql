-- Brief Seven: The Retention Architecture. Five-layer memory that scales for a
-- decade — Layer 4 (semantic memory) via pgvector, plus the audit/versioning/
-- consolidation scaffolding.

create extension if not exists vector;

-- Layer 4 — semantic memory: embed every journal entry + answer on write.
-- text-embedding-3-small = 1536 dims.
alter table public.silk_journal add column if not exists embedding vector(1536);
alter table public.mat_answers  add column if not exists embedding vector(1536);
create index if not exists idx_silk_journal_embedding on public.silk_journal using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists idx_mat_answers_embedding on public.mat_answers using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists idx_silk_journal_created on public.silk_journal (created_at desc);

-- The Retrieval Assembly audit trail — what every Silk call was "thinking with".
create table if not exists public.prompt_assemblies (
  id                     uuid primary key default gen_random_uuid(),
  silk_call_id           text,                         -- chat_id / draft id / run label
  surface                text,                         -- silk-chat | foundry-generate | conversation-distiller | ...
  task_type              text,                         -- classifier output
  layer_1_hash           text,                         -- identity version bound to this call
  layer_2_sections       jsonb not null default '[]'::jsonb,
  layer_3_skills         jsonb not null default '[]'::jsonb,
  layer_4_entries        jsonb not null default '[]'::jsonb,   -- retrieved journal/answer ids
  layer_5_functions      jsonb not null default '[]'::jsonb,   -- ledger query fns advertised
  created_at             timestamptz not null default now()
);
create index if not exists idx_prompt_assemblies_created on public.prompt_assemblies (created_at desc);

-- Doctrine versioning — every doctrine-file edit records what changed and why.
create table if not exists public.doctrine_versions (
  id                          uuid primary key default gen_random_uuid(),
  file_path                   text not null,
  version                     text not null,
  content_hash                text not null,
  previous_version_hash       text,
  trigger                     text,                     -- correction / journal pattern / synthesis proposal
  rationale                   text,
  changed_at                  timestamptz not null default now()
);
create index if not exists idx_doctrine_versions_file on public.doctrine_versions (file_path, changed_at desc);

-- Pruning target — archived (consolidated) journal entries stay queryable, out of the default pool.
create table if not exists public.silk_journal_archive (
  id          uuid primary key,
  run_id      uuid,
  entry       text not null,
  tags        text[] not null default '{}',
  embedding   vector(1536),
  created_at  timestamptz not null,
  archived_at timestamptz not null default now(),
  archive_reason text
);

-- Future-facing (agent two): the shared doctrine-proposal surface. Empty for now.
create table if not exists public.hive_channel (
  id              uuid primary key default gen_random_uuid(),
  proposed_by     text not null,                        -- agent id
  proposal_text   text not null,
  category        text,                                 -- hive-general | silk-specific | ...
  status          text not null default 'proposed' check (status in ('proposed','approved','rejected')),
  mat_approved_at timestamptz,
  created_at      timestamptz not null default now()
);

alter table public.prompt_assemblies enable row level security;
alter table public.doctrine_versions enable row level security;
alter table public.silk_journal_archive enable row level security;
alter table public.hive_channel enable row level security;
create policy prompt_assemblies_owner on public.prompt_assemblies for select to authenticated using (public.is_parlor_owner());
create policy doctrine_versions_owner on public.doctrine_versions for select to authenticated using (public.is_parlor_owner());
create policy silk_journal_archive_owner on public.silk_journal_archive for select to authenticated using (public.is_parlor_owner());
create policy hive_channel_owner on public.hive_channel for select to authenticated using (public.is_parlor_owner());

-- RPC for Layer 4 cosine retrieval (SECURITY DEFINER; callable by service role in functions).
create or replace function public.match_journal(query_embedding vector(1536), match_count int default 6)
returns table (id uuid, entry text, tags text[], created_at timestamptz, similarity float)
language sql stable as $$
  select j.id, j.entry, j.tags, j.created_at, 1 - (j.embedding <=> query_embedding) as similarity
  from public.silk_journal j
  where j.embedding is not null
  order by j.embedding <=> query_embedding
  limit match_count;
$$;
