-- Migration: 002_destination_url_nullable
-- Allow offers.destination_url and offers.destination_url_hash to be NULL.
-- Tier 2 now refuses to invent URLs and emits NULL when the post body has none;
-- those rows land in human_review_queue and an admin fills the URL in via the
-- dashboard offer-edit page.
--
-- Apply via Supabase SQL Editor or CLI:
--   psql $DATABASE_URL -f packages/db/src/migrations/002_destination_url_nullable.sql

ALTER TABLE offers ALTER COLUMN destination_url DROP NOT NULL;
ALTER TABLE offers ALTER COLUMN destination_url_hash DROP NOT NULL;
