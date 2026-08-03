-- ==========================================================================
-- TBFlog schema — multi-user foundation (auth + training-program tables).
--
-- This script is SAFE TO COPY AND RUN IN FULL, ANY TIME, as many times as
-- you want. Every statement either skips itself if already done
-- (`if not exists`) or cleanly replaces itself (`create or replace`,
-- `drop ... if exists` before recreating). Nothing here is destructive to
-- existing data - it only ever adds tables/columns/rules, never drops data.
--
-- History note: athletes.id turned out to be `bigint` (a plain number),
-- not `uuid` as first assumed - every foreign key pointing at athletes.id
-- below is `bigint` to match. This is the corrected, consolidated version.
-- ==========================================================================

-- --- profiles: one row per logged-in user (coach or athlete) ---
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('coach','athlete')),
  name text,
  created_at timestamptz not null default now()
);

-- Auto-creates a profiles row whenever someone signs up, reading role/name
-- out of the signup metadata. Client code never inserts into profiles directly.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, role, name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'role', 'athlete'),
          coalesce(new.raw_user_meta_data ->> 'name', ''))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_coach()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'coach');
$$;

-- profiles RLS: users can see/rename their own profile, but can never write
-- their own `role` column directly (only the trigger above can set it) -
-- this is what stops an athlete from making themselves a coach.
alter table profiles enable row level security;
drop policy if exists "select own profile" on profiles;
create policy "select own profile" on profiles for select using (id = auth.uid());
drop policy if exists "update own profile" on profiles;
create policy "update own profile" on profiles for update using (id = auth.uid()) with check (id = auth.uid());
revoke update on profiles from authenticated;
grant update (name) on profiles to authenticated;

-- --- athletes: link each athlete row to a coach, and (once they sign up) to their own login ---
alter table athletes add column if not exists coach_id uuid references auth.users(id);
alter table athletes add column if not exists user_id  uuid references auth.users(id);
alter table athletes add column if not exists email    text;
create unique index if not exists athletes_user_id_key on athletes (user_id) where user_id is not null;
create unique index if not exists athletes_email_lower_key on athletes (lower(email)) where email is not null;

-- --- claim function: links a newly-signed-up athlete's login to their existing athlete row ---
create or replace function public.claim_athlete_by_email()
returns bigint language plpgsql security definer set search_path = public as $$
declare matched_id bigint;
begin
  select id into matched_id from athletes
  where user_id is null and email is not null and lower(email) = lower(auth.email())
  limit 1;
  if matched_id is null then
    raise exception 'no unclaimed athlete found for this email';
  end if;
  update athletes set user_id = auth.uid() where id = matched_id;
  return matched_id;
end; $$;
grant execute on function public.claim_athlete_by_email() to authenticated;

-- --- exercises: coach's reusable exercise library ---
create table if not exists exercises (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id),
  name text not null, category text, instructions text,
  created_at timestamptz not null default now()
);
alter table exercises enable row level security;
drop policy if exists "coach manages own exercise library" on exercises;
create policy "coach manages own exercise library" on exercises for all
  using (coach_id = auth.uid()) with check (coach_id = auth.uid() and is_coach());
drop policy if exists "athlete views own coach's exercises" on exercises;
create policy "athlete views own coach's exercises" on exercises for select
  using (exists (select 1 from athletes a where a.user_id = auth.uid() and a.coach_id = exercises.coach_id));

-- --- programs: one training program belongs to exactly one athlete ---
create table if not exists programs (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id),
  athlete_id bigint not null references athletes(id) on delete cascade,
  name text not null, start_date date,
  created_at timestamptz not null default now()
);
alter table programs enable row level security;
drop policy if exists "coach manages own programs" on programs;
create policy "coach manages own programs" on programs for all
  using (coach_id = auth.uid())
  with check (coach_id = auth.uid() and is_coach()
    and exists (select 1 from athletes a where a.id = programs.athlete_id and a.coach_id = auth.uid()));
drop policy if exists "athlete views own programs" on programs;
create policy "athlete views own programs" on programs for select
  using (exists (select 1 from athletes a where a.id = programs.athlete_id and a.user_id = auth.uid()));

-- --- program_weeks ---
create table if not exists program_weeks (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references programs(id) on delete cascade,
  week_number int not null, unique (program_id, week_number)
);
alter table program_weeks enable row level security;
drop policy if exists "coach manages own program weeks" on program_weeks;
create policy "coach manages own program weeks" on program_weeks for all
  using (exists (select 1 from programs p where p.id = program_weeks.program_id and p.coach_id = auth.uid()))
  with check (exists (select 1 from programs p where p.id = program_weeks.program_id and p.coach_id = auth.uid()));
drop policy if exists "athlete views own program weeks" on program_weeks;
create policy "athlete views own program weeks" on program_weeks for select
  using (exists (select 1 from programs p join athletes a on a.id = p.athlete_id
                 where p.id = program_weeks.program_id and a.user_id = auth.uid()));

-- --- program_days ---
create table if not exists program_days (
  id uuid primary key default gen_random_uuid(),
  week_id uuid not null references program_weeks(id) on delete cascade,
  day_number int not null, label text, unique (week_id, day_number)
);
alter table program_days enable row level security;
drop policy if exists "coach manages own program days" on program_days;
create policy "coach manages own program days" on program_days for all
  using (exists (select 1 from program_weeks w join programs p on p.id = w.program_id
                 where w.id = program_days.week_id and p.coach_id = auth.uid()))
  with check (exists (select 1 from program_weeks w join programs p on p.id = w.program_id
                 where w.id = program_days.week_id and p.coach_id = auth.uid()));
drop policy if exists "athlete views own program days" on program_days;
create policy "athlete views own program days" on program_days for select
  using (exists (select 1 from program_weeks w join programs p on p.id = w.program_id join athletes a on a.id = p.athlete_id
                 where w.id = program_days.week_id and a.user_id = auth.uid()));

-- --- program_exercises: prescribed sets/reps/weight per exercise per day ---
create table if not exists program_exercises (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references program_days(id) on delete cascade,
  exercise_id uuid not null references exercises(id),
  order_index int not null default 0,
  prescribed_sets int,
  prescribed_reps text,
  prescribed_weight numeric,
  notes text,
  created_at timestamptz not null default now()
);
alter table program_exercises enable row level security;
drop policy if exists "coach manages own program exercises" on program_exercises;
create policy "coach manages own program exercises" on program_exercises for all
  using (exists (select 1 from program_days d join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id
                 where d.id = program_exercises.day_id and p.coach_id = auth.uid()))
  with check (exists (select 1 from program_days d join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id
                 where d.id = program_exercises.day_id and p.coach_id = auth.uid()));
drop policy if exists "athlete views own program exercises" on program_exercises;
create policy "athlete views own program exercises" on program_exercises for select
  using (exists (select 1 from program_days d join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id join athletes a on a.id = p.athlete_id
                 where d.id = program_exercises.day_id and a.user_id = auth.uid()));

-- --- exercise_logs: what the athlete actually did ---
create table if not exists exercise_logs (
  id uuid primary key default gen_random_uuid(),
  program_exercise_id uuid not null references program_exercises(id) on delete cascade,
  athlete_id bigint not null references athletes(id),
  date date not null default current_date,
  actual_sets int, actual_reps text, actual_weight numeric,
  notes text, completed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table exercise_logs enable row level security;
drop policy if exists "coach views logs for own athletes" on exercise_logs;
create policy "coach views logs for own athletes" on exercise_logs for select
  using (exists (select 1 from athletes a where a.id = exercise_logs.athlete_id and a.coach_id = auth.uid()));
drop policy if exists "athlete manages own exercise logs" on exercise_logs;
create policy "athlete manages own exercise logs" on exercise_logs for all
  using (exists (select 1 from athletes a where a.id = exercise_logs.athlete_id and a.user_id = auth.uid()))
  with check (
    exists (select 1 from athletes a where a.id = exercise_logs.athlete_id and a.user_id = auth.uid())
    and exists (select 1 from program_exercises pe join program_days d on d.id = pe.day_id
                join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id
                where pe.id = exercise_logs.program_exercise_id and p.athlete_id = exercise_logs.athlete_id)
  );

-- ==========================================================================
-- Turn on RLS for the 6 pre-existing tables (athletes, metrics,
-- athlete_metrics, measurements, bodyweight, athlete_notes). Before this,
-- every one of these tables was wide open to anyone with the anon key.
-- Coach access is scoped through athletes.coach_id (set by the earlier
-- backfill); metrics stays a shared/global library for now (single coach).
-- Same safe-to-rerun pattern as above - nothing here deletes data.
-- ==========================================================================

alter table athletes enable row level security;
drop policy if exists "coach full access to own athletes" on athletes;
create policy "coach full access to own athletes" on athletes for all
  using (coach_id = auth.uid()) with check (coach_id = auth.uid());
drop policy if exists "athlete can view own row" on athletes;
create policy "athlete can view own row" on athletes for select using (user_id = auth.uid());

alter table metrics enable row level security;
drop policy if exists "coaches manage global metrics library" on metrics;
create policy "coaches manage global metrics library" on metrics for all
  using (is_coach()) with check (is_coach());

alter table athlete_metrics enable row level security;
drop policy if exists "coach manages own athletes athlete_metrics" on athlete_metrics;
create policy "coach manages own athletes athlete_metrics" on athlete_metrics for all
  using (exists (select 1 from athletes a where a.id = athlete_metrics.athlete_id and a.coach_id = auth.uid()))
  with check (exists (select 1 from athletes a where a.id = athlete_metrics.athlete_id and a.coach_id = auth.uid()));

alter table measurements enable row level security;
drop policy if exists "coach manages own athletes measurements" on measurements;
create policy "coach manages own athletes measurements" on measurements for all
  using (exists (select 1 from athletes a where a.id = measurements.athlete_id and a.coach_id = auth.uid()))
  with check (exists (select 1 from athletes a where a.id = measurements.athlete_id and a.coach_id = auth.uid()));

alter table bodyweight enable row level security;
drop policy if exists "coach manages own athletes bodyweight" on bodyweight;
create policy "coach manages own athletes bodyweight" on bodyweight for all
  using (exists (select 1 from athletes a where a.id = bodyweight.athlete_id and a.coach_id = auth.uid()))
  with check (exists (select 1 from athletes a where a.id = bodyweight.athlete_id and a.coach_id = auth.uid()));

alter table athlete_notes enable row level security;
drop policy if exists "coach manages own athletes notes" on athlete_notes;
create policy "coach manages own athletes notes" on athlete_notes for all
  using (exists (select 1 from athletes a where a.id = athlete_notes.athlete_id and a.coach_id = auth.uid()))
  with check (exists (select 1 from athletes a where a.id = athlete_notes.athlete_id and a.coach_id = auth.uid()));

-- ==========================================================================
-- Program builder + calendar: let `programs` hold reusable, athlete-agnostic
-- TEMPLATES (built in a library, no athlete_id yet) as well as real
-- athlete-owned instances (assigned-from-template or ad-hoc single-day
-- additions). athlete_id has to become nullable so a template row can exist
-- with no athlete attached.
-- ==========================================================================

alter table programs alter column athlete_id drop not null;
alter table programs add column if not exists is_template boolean not null default false;
-- Tells apart the Calendar's "+ Add Training" quick-add container for one
-- date from a real assigned-template instance - both are is_template=false
-- with athlete_id set, so without this flag there's no reliable way to tell
-- them apart in the Calendar UI.
alter table programs add column if not exists is_adhoc boolean not null default false;

-- Old policy assumed athlete_id was always set, which breaks on template
-- rows. New version: a row must be EITHER a template (is_template=true,
-- athlete_id null) OR a real instance owned by one of this coach's athletes
-- - enforced at the database level, not just trusted from the UI.
drop policy if exists "coach manages own programs" on programs;
create policy "coach manages own programs" on programs for all
  using (
    coach_id = auth.uid()
    and (
      athlete_id is null
      or exists (select 1 from athletes a where a.id = programs.athlete_id and a.coach_id = auth.uid())
    )
  )
  with check (
    coach_id = auth.uid() and is_coach()
    and (
      (is_template and athlete_id is null)
      or (not is_template and athlete_id is not null
          and exists (select 1 from athletes a where a.id = programs.athlete_id and a.coach_id = auth.uid()))
    )
  );

-- Unchanged logic, just re-asserted here: athlete_id is null on template
-- rows, so this join already returns zero rows for templates - athletes
-- were never able to see them and still can't.
drop policy if exists "athlete views own programs" on programs;
create policy "athlete views own programs" on programs for select
  using (exists (select 1 from athletes a where a.id = programs.athlete_id and a.user_id = auth.uid()));

-- ==========================================================================
-- Exercises: what kind of exercise it is (drives which prescribed fields
-- show up when adding it to a program - weights gets sets/reps/weight,
-- timed gets sets/duration) and an optional demo video link. No RLS change
-- needed - both columns are covered by the existing "coach manages own
-- exercise library" policy.
-- ==========================================================================
alter table exercises add column if not exists type text not null default 'weights';
alter table exercises add column if not exists video_url text;

-- Free-form extra prescribed fields per exercise-in-a-day (e.g. "% of 1RM":
-- "75", "RPE": "8") on top of the built-in sets/reps/weight columns - lets
-- a coach attach whatever extra number they want to track without a schema
-- change every time. No RLS change needed - covered by the existing
-- program_exercises policies (they don't reference individual columns).
alter table program_exercises add column if not exists extra_fields jsonb;

-- ==========================================================================
-- Training Library: reusable single-day workouts (just a flat list of
-- exercises, no weeks/days) a coach can build once and either drop onto any
-- athlete's calendar via "+ Add Training", or use as a starting point they
-- tweak per-athlete. Separate from `programs` on purpose - a "training" is
-- always one flat session, not a multi-week structure, so it doesn't need
-- the program_weeks/program_days layers at all.
-- ==========================================================================
create table if not exists trainings (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id),
  name text not null,
  created_at timestamptz not null default now()
);
alter table trainings enable row level security;
drop policy if exists "coach manages own trainings" on trainings;
create policy "coach manages own trainings" on trainings for all
  using (coach_id = auth.uid()) with check (coach_id = auth.uid());

create table if not exists training_exercises (
  id uuid primary key default gen_random_uuid(),
  training_id uuid not null references trainings(id) on delete cascade,
  exercise_id uuid not null references exercises(id),
  order_index int not null default 0,
  prescribed_sets int,
  prescribed_reps text,
  prescribed_weight numeric,
  extra_fields jsonb,
  notes text,
  created_at timestamptz not null default now()
);
alter table training_exercises enable row level security;
drop policy if exists "coach manages own training exercises" on training_exercises;
create policy "coach manages own training exercises" on training_exercises for all
  using (exists (select 1 from trainings t where t.id = training_exercises.training_id and t.coach_id = auth.uid()))
  with check (exists (select 1 from trainings t where t.id = training_exercises.training_id and t.coach_id = auth.uid()));

-- ==========================================================================
-- Athlete-side logging. rest_seconds is a coach-prescribed value (how long
-- to rest between sets), same lifecycle as prescribed_sets/reps/weight - set
-- on program_exercises, seeded from training_exercises when a Training is
-- cloned onto a day. No RLS change needed for either column - both tables'
-- existing "coach manages own..." policies aren't column-scoped.
-- ==========================================================================
alter table program_exercises add column if not exists rest_seconds int;
alter table training_exercises add column if not exists rest_seconds int;

-- exercise_logs (from the original auth-foundation plan) was added as
-- foresight but never wired to any UI, and its shape - one row per exercise
-- per day, a single aggregate actual_sets/actual_reps/actual_weight -
-- doesn't fit per-set logging. Replacing it outright, not migrating (it
-- holds no real data).
drop table if exists exercise_logs;

-- --- exercise_log_sets: one row per set the athlete actually logs.
-- unique(program_exercise_id, date, set_number) makes "check a set" an
-- upsert - re-checking the same set updates it instead of duplicating. ---
create table if not exists exercise_log_sets (
  id uuid primary key default gen_random_uuid(),
  program_exercise_id uuid not null references program_exercises(id) on delete cascade,
  athlete_id bigint not null references athletes(id) on delete cascade,
  date date not null default current_date,
  set_number int not null,
  actual_reps text,
  actual_weight numeric,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (program_exercise_id, date, set_number)
);
alter table exercise_log_sets enable row level security;
drop policy if exists "coach views log sets for own athletes" on exercise_log_sets;
create policy "coach views log sets for own athletes" on exercise_log_sets for select
  using (exists (select 1 from athletes a where a.id = exercise_log_sets.athlete_id and a.coach_id = auth.uid()));
drop policy if exists "athlete manages own log sets" on exercise_log_sets;
create policy "athlete manages own log sets" on exercise_log_sets for all
  using (exists (select 1 from athletes a where a.id = exercise_log_sets.athlete_id and a.user_id = auth.uid()))
  with check (
    exists (select 1 from athletes a where a.id = exercise_log_sets.athlete_id and a.user_id = auth.uid())
    and exists (select 1 from program_exercises pe join program_days d on d.id = pe.day_id
                join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id
                where pe.id = exercise_log_sets.program_exercise_id and p.athlete_id = exercise_log_sets.athlete_id)
  );

-- ==========================================================================
-- Week view, guided workout flow. can_preview_next_week is a per-athlete
-- permission (off by default) the coach flips on for athletes they want to
-- let plan ahead. workout_sessions gives a real Start-Workout ->
-- Finish-Workout duration - volume is intentionally not cached here, it's
-- computed on demand from exercise_log_sets (actual_weight x actual_reps).
-- ==========================================================================
alter table athletes add column if not exists can_preview_next_week boolean not null default false;

create table if not exists workout_sessions (
  id uuid primary key default gen_random_uuid(),
  program_day_id uuid not null references program_days(id) on delete cascade,
  athlete_id bigint not null references athletes(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
alter table workout_sessions enable row level security;
drop policy if exists "coach views sessions for own athletes" on workout_sessions;
create policy "coach views sessions for own athletes" on workout_sessions for select
  using (exists (select 1 from athletes a where a.id = workout_sessions.athlete_id and a.coach_id = auth.uid()));
drop policy if exists "athlete manages own sessions" on workout_sessions;
create policy "athlete manages own sessions" on workout_sessions for all
  using (exists (select 1 from athletes a where a.id = workout_sessions.athlete_id and a.user_id = auth.uid()))
  with check (
    exists (select 1 from athletes a where a.id = workout_sessions.athlete_id and a.user_id = auth.uid())
    and exists (select 1 from program_days d join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id
                where d.id = workout_sessions.program_day_id and p.athlete_id = workout_sessions.athlete_id)
  );

-- ==========================================================================
-- Lbs/kg display preference. Weight is still always STORED in kg (the
-- metric-units rule never changes) - weight_unit only controls what unit
-- the athlete's own dashboard converts to for display/entry. Needs its own
-- update policy since "athlete can view own row" (line 207) is select-only
-- and athletes previously had no way to change their own row at all.
-- ==========================================================================
alter table athletes add column if not exists weight_unit text not null default 'kg' check (weight_unit in ('kg', 'lbs'));

drop policy if exists "athlete updates own settings" on athletes;
create policy "athlete updates own settings" on athletes for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
