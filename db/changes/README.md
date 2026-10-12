Numbered change files go here, e.g. `0001-add-something.sql`. See ../README.md.

Changes since the snapshot in ../schema.sql (2026-10-09):

| File | What | Run in Supabase? |
|---|---|---|
| `0001-athlete-data-follows-athlete.sql` | bodyweight, measurements, athlete_metrics, athlete_notes get a foreign key to athletes with cascade, so deleting an athlete removes them | yes, 2026-10-12 (no rows without an athlete) |
