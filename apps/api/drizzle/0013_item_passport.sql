ALTER TABLE "listings" ADD COLUMN "grade" text GENERATED ALWAYS AS (case
        when condition is null or condition = 'unknown' then null
        when condition = 'broken' then 'D'
        when condition = 'fair'
          or (checklist->>'batteryPct')::int < 80
          or checklist->>'biometrics' = 'broken'
          or checklist->>'deadPixels' = 'many' then 'C'
        when condition = 'good'
          or (checklist->>'batteryPct')::int < 85
          or checklist->>'deadPixels' = 'few'
          or checklist->>'mining' = 'yes'
          or checklist->'repairs' @> '["screen"]' or checklist->'repairs' @> '["battery"]'
          or checklist->'repairs' @> '["back"]' or checklist->'repairs' @> '["other"]' then 'B'
        else 'A'
      end) STORED;