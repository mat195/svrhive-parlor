-- Brief Four Phase 4 UX — Silk's Questions render for Mat, not the ledger.
-- question_context: structured preview {type: link|release|collaborator|platform|text, ...}
-- why_asking: one plain-language sentence in Silk's voice (optional).
-- source_ref stays the INTERNAL path (shown only behind an ⓘ, never front-and-center).
alter table public.silk_questions add column if not exists question_context jsonb not null default '{}'::jsonb;
alter table public.silk_questions add column if not exists why_asking text;
