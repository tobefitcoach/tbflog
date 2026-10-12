-- 0002: consistency streak ("4 weeks in a row", "26/28 in the last 30 days").
--
-- 1. athletes.streak_enabled: the coach's per-athlete switch (Settings tab).
--    On by default. The athlete app reads it on its own, so it keeps working
--    (streak shown) until this is run.
-- 2. athlete_consistency(): per calendar day, how many coach-scheduled
--    workouts the athlete has and how many of those they finished. One small
--    row per scheduled day, so a year of history is cheap - the full
--    schedule/log-set download (athlete_schedule_range) would not be.
--    A "scheduled workout" is a day in one of the athlete's own programs
--    that has at least one exercise, not made by the athlete themselves.
--    "Finished" = a training session on that day that was ended.
--
-- Safe to run twice.

alter table public.athletes
  add column if not exists streak_enabled boolean not null default true;

create or replace function public.athlete_consistency(p_athlete_id bigint, p_from date, p_to date)
 returns table(day_date date, scheduled integer, done integer)
 language sql
 stable
 set search_path to 'public'
as $function$
  select x.day_date,
         count(*)::int as scheduled,
         (count(*) filter (where exists (
            select 1 from workout_sessions s
            where s.program_day_id = x.day_id
              and s.athlete_id = p_athlete_id
              and s.session_type = 'training'
              and s.ended_at is not null
         )))::int as done
  from (
    select d.id as day_id,
           coalesce(d.date_override, p.start_date + ((w.week_number - 1) * 7 + (d.day_number - 1))) as day_date
    from programs p
    join program_weeks w on w.program_id = p.id
    join program_days d on d.week_id = w.id
    where p.athlete_id = p_athlete_id
      and p.is_template = false
      and p.created_by_athlete = false
      and exists (select 1 from program_exercises pe where pe.day_id = d.id)
  ) x
  where x.day_date between p_from and p_to
  group by x.day_date
  order by x.day_date
$function$;
