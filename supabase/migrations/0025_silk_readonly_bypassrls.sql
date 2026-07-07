-- query_database reads returned zero rows: app tables have RLS scoped `to authenticated`
-- with an owner-email check, and silk_readonly is neither, so RLS filtered everything out.
-- Silk is the owner's own read-only agent (silk-chat is owner-session only), so it should
-- see exactly what the owner sees. Grant BYPASSRLS to the read role. It remains SELECT-only
-- and still has NO access to auth.* / vault.* (blocked at the schema-permission level, which
-- BYPASSRLS does not touch).
alter role silk_readonly bypassrls;
