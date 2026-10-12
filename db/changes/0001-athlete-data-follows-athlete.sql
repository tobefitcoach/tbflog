-- 0001: bodyweight, measurements, athlete_metrics and athlete_notes now go away with the athlete.
--
-- Why: these four tables were made in the Supabase dashboard and never got a foreign key to
-- athletes, unlike every other per-athlete table. Deleting an athlete (coach "delete athlete" or
-- the delete-account edge function) left their weigh-ins, measurements, metric choices and notes
-- behind, although delete-account promises full erasure.
--
-- What it does:
--   1. Removes rows whose athlete no longer exists (they are unreachable already: the row-level
--      security policies all go through the athlete, so nobody can see them).
--   2. Adds athlete_id -> athletes(id) ON DELETE CASCADE, same as the other tables.
--
-- Rows with athlete_id NULL are left alone (a foreign key allows NULL); the check below counts them.
--
-- To see what step 1 will remove before running, run these four selects first:
--   select count(*) from bodyweight       b where b.athlete_id is not null and not exists (select 1 from athletes a where a.id = b.athlete_id);
--   select count(*) from measurements     m where m.athlete_id is not null and not exists (select 1 from athletes a where a.id = m.athlete_id);
--   select count(*) from athlete_metrics  x where x.athlete_id is not null and not exists (select 1 from athletes a where a.id = x.athlete_id);
--   select count(*) from athlete_notes    n where n.athlete_id is not null and not exists (select 1 from athletes a where a.id = n.athlete_id);
--
-- Safe to run twice.

begin;

delete from public.bodyweight      t where t.athlete_id is not null and not exists (select 1 from public.athletes a where a.id = t.athlete_id);
delete from public.measurements    t where t.athlete_id is not null and not exists (select 1 from public.athletes a where a.id = t.athlete_id);
delete from public.athlete_metrics t where t.athlete_id is not null and not exists (select 1 from public.athletes a where a.id = t.athlete_id);
delete from public.athlete_notes   t where t.athlete_id is not null and not exists (select 1 from public.athletes a where a.id = t.athlete_id);

alter table public.bodyweight drop constraint if exists bodyweight_athlete_id_fkey;
alter table public.bodyweight add constraint bodyweight_athlete_id_fkey
  foreign key (athlete_id) references public.athletes(id) on delete cascade;

alter table public.measurements drop constraint if exists measurements_athlete_id_fkey;
alter table public.measurements add constraint measurements_athlete_id_fkey
  foreign key (athlete_id) references public.athletes(id) on delete cascade;

alter table public.athlete_metrics drop constraint if exists athlete_metrics_athlete_id_fkey;
alter table public.athlete_metrics add constraint athlete_metrics_athlete_id_fkey
  foreign key (athlete_id) references public.athletes(id) on delete cascade;

alter table public.athlete_notes drop constraint if exists athlete_notes_athlete_id_fkey;
alter table public.athlete_notes add constraint athlete_notes_athlete_id_fkey
  foreign key (athlete_id) references public.athletes(id) on delete cascade;

commit;

-- Check (read-only): rows with no athlete at all. Expected 0 each; if not, they were never
-- attached to anyone and can be deleted by hand.
select 'bodyweight' as tbl, count(*) as rows_without_athlete from public.bodyweight where athlete_id is null
union all select 'measurements',    count(*) from public.measurements    where athlete_id is null
union all select 'athlete_metrics', count(*) from public.athlete_metrics where athlete_id is null
union all select 'athlete_notes',   count(*) from public.athlete_notes   where athlete_id is null;
