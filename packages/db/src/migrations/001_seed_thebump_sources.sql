-- Migration: 001_seed_thebump_sources
-- Adds TheBump subforum source rows to the sources table (type='bump').
-- Two rows: freebies-and-deals + deals (ROADMAP SC#5 requires both).
-- Safe to re-run: ON CONFLICT (identifier) DO NOTHING.
--
-- Apply via Supabase SQL Editor or CLI:
--   psql $DATABASE_URL -f packages/db/src/migrations/001_seed_thebump_sources.sql

-- TheBump Freebies subforum
INSERT INTO sources (type, identifier, config)
VALUES (
  'bump',
  'https://community.thebump.com/categories/freebies-and-deals',
  '{
    "base_url": "https://community.thebump.com",
    "subforum_path": "/categories/freebies-and-deals",
    "max_pages": 10
  }'::jsonb
)
ON CONFLICT (identifier) DO NOTHING;

-- TheBump Deals subforum
INSERT INTO sources (type, identifier, config)
VALUES (
  'bump',
  'https://community.thebump.com/categories/deals',
  '{
    "base_url": "https://community.thebump.com",
    "subforum_path": "/categories/deals",
    "max_pages": 10
  }'::jsonb
)
ON CONFLICT (identifier) DO NOTHING;
