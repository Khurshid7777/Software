-- Metrics: events are read by name and period.
CREATE INDEX "events_name_created_idx" ON "events" USING btree ("name", "created_at");--> statement-breakpoint
-- Duplicate photos: a 64-bit dHash split into 8 one-byte bands ("<band>:<hex>"). Two hashes within
-- Hamming distance 6 share at least 2 identical bands (pigeonhole), so the GIN index on bands finds
-- candidates and bit_count() confirms them, instead of scanning every photo.
ALTER TABLE "listing_photos" ADD COLUMN "phash_bands" text[] GENERATED ALWAYS AS (
  CASE WHEN "phash" IS NULL OR length("phash") <> 16 THEN NULL ELSE ARRAY[
    '0:' || substr("phash", 1, 2), '1:' || substr("phash", 3, 2), '2:' || substr("phash", 5, 2), '3:' || substr("phash", 7, 2),
    '4:' || substr("phash", 9, 2), '5:' || substr("phash", 11, 2), '6:' || substr("phash", 13, 2), '7:' || substr("phash", 15, 2)
  ] END
) STORED;--> statement-breakpoint
CREATE INDEX "listing_photos_phash_bands_idx" ON "listing_photos" USING gin ("phash_bands");
