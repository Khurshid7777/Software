-- Market price from similar catalog listings: `coalesce(attributes->>'modelKey', '') % key` uses this index.
CREATE INDEX IF NOT EXISTS "listings_model_key_trgm_idx" ON "listings" USING gin ((coalesce("attributes"->>'modelKey', '')) gin_trgm_ops);
