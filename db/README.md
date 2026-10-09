# Database

The database is Supabase (Postgres). Changes are run by hand in the Supabase
SQL editor, so the files here are the record, not an automatic migration tool.

| File | What it is |
|---|---|
| `schema.sql` | Snapshot of the live database (taken 2026-10-09). The source of truth for what exists now. For reading and for building a throwaway copy - **don't run it on the live database**. |
| `changes/` | Everything changed *since* the snapshot, one numbered file each (`0001-short-name.sql`, `0002-...`). |
| `dump-schema.sql` | Run in the Supabase SQL editor to regenerate the snapshot (one cell of SQL, read-only). |
| `../sql-history.sql` | Frozen. How the database got to the snapshot, with the reasoning in its comments. |

## Making a change

1. Add `db/changes/NNNN-what-it-does.sql` (next number). Write it so running it twice is harmless
   (`create or replace`, `if not exists`, `drop ... if exists` before `create`), and put the *why* in a comment at the top.
2. Run it in the Supabase SQL editor.
3. Make the app tolerate the change not being there yet where it makes sense (the apps already fall back when a
   function is missing - `PGRST202`).
4. Now and then (or after a big change), run `dump-schema.sql`, save the result as `schema.sql`
   (keep the header comment), and note which change files it now includes.

## Checking a change before running it

Load `schema.sql` into a throwaway Postgres (the project's tests use pglite with small stand-ins for
Supabase's `auth` and `storage` schemas), run the new file on top, and try it.
