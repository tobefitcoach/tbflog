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

-- ==========================================================================
-- Weekly recap opt-in (settings only, for now). Just capturing what each
-- athlete wants, reusing "athlete updates own settings" above - no need
-- for a new policy. Actually SENDING a recap is a separate, much bigger
-- piece of work (a service worker, push subscriptions, and a scheduled job)
-- that's deliberately not built yet. Workout-reminder timing (night
-- before/morning of) is left out entirely for the same reason, for now.
-- ==========================================================================
alter table athletes add column if not exists weekly_recap_enabled boolean not null default false;

-- Switched to opt-OUT: athletes get the recap unless they turn it off in
-- Settings. Backfills existing rows too, since the intent is "everyone
-- gets it by default" going forward, not just new signups.
alter table athletes alter column weekly_recap_enabled set default true;
update athletes set weekly_recap_enabled = true where weekly_recap_enabled = false;

-- ==========================================================================
-- MISSING INDEXES - the real cause of "saving takes forever". Postgres does
-- NOT automatically index foreign key columns (only primary keys and
-- explicit unique constraints get one for free). Almost every RLS policy in
-- this app checks permission by walking a join chain - e.g. saving a set
-- checks program_exercises -> program_days -> program_weeks -> programs -
-- and every one of those join columns has been unindexed since day one.
-- That means every single set save has been asking Postgres to scan whole
-- tables to prove permission, and it only gets slower as more programs/
-- weeks/days/logs pile up, which is exactly the "still happens, gets worse
-- over time" pattern being reported. Client-side retry/timeout/parallelism
-- work (already done) can't fix a slow query - it can only fail faster.
-- Purely additive and safe to run anytime: indexes never change what a
-- query returns, only how fast Postgres can find it.
-- ==========================================================================
create index if not exists idx_athletes_coach_id on athletes(coach_id);

create index if not exists idx_exercises_coach_id on exercises(coach_id);

create index if not exists idx_programs_coach_id on programs(coach_id);
create index if not exists idx_programs_athlete_id on programs(athlete_id);

create index if not exists idx_program_weeks_program_id on program_weeks(program_id);
create index if not exists idx_program_days_week_id on program_days(week_id);
create index if not exists idx_program_exercises_day_id on program_exercises(day_id);

create index if not exists idx_trainings_coach_id on trainings(coach_id);
create index if not exists idx_training_exercises_training_id on training_exercises(training_id);

create index if not exists idx_exercise_log_sets_athlete_id on exercise_log_sets(athlete_id);
create index if not exists idx_workout_sessions_athlete_id on workout_sessions(athlete_id);
create index if not exists idx_workout_sessions_program_day_id on workout_sessions(program_day_id);

create index if not exists idx_athlete_metrics_athlete_id on athlete_metrics(athlete_id);
create index if not exists idx_measurements_athlete_id on measurements(athlete_id);
create index if not exists idx_bodyweight_athlete_id on bodyweight(athlete_id);
create index if not exists idx_athlete_notes_athlete_id on athlete_notes(athlete_id);

-- ==========================================================================
-- Training load tracking, Phase 1: session RPE. Entered by the athlete right
-- after finishing a workout (post-workout summary screen, dashboard.js) -
-- session_load itself (RPE x duration) is intentionally NOT stored here,
-- same as every other derived number in this app (volume, duration) - it's
-- always computed on demand from this column plus the already-existing
-- started_at/ended_at, so there's never a stale cached value to keep in
-- sync. No RLS change needed - already covered by the existing "athlete
-- manages own sessions"/"coach views sessions for own athletes" policies.
--
-- Also indexes program_exercises.exercise_id, used by the new PR-detection
-- query (finding every past session logged for a given exercise, across
-- every program/week it's ever been assigned in) - same "unindexed foreign
-- key = slow query" issue as the indexes added above.
-- ==========================================================================
alter table workout_sessions add column if not exists session_rpe int check (session_rpe between 1 and 10);
create index if not exists idx_program_exercises_exercise_id on program_exercises(exercise_id);

-- ==========================================================================
-- Training load tracking, Phase 2: plyometric load. foot_contacts/
-- intensity_tier are fixed per exercise (set once in the Exercise Library,
-- exercises.js), not logged per set by the athlete - same reasoning as
-- video_url/instructions already being fixed exercise metadata, not
-- per-assignment data. plyo_load itself (foot_contacts x intensity
-- multiplier x completed sets) is computed on demand in dashboard.js, never
-- stored, matching every other derived number in this app. No RLS change -
-- covered by the existing "coach manages own exercise library" policy.
-- ==========================================================================
alter table exercises add column if not exists foot_contacts int;
alter table exercises add column if not exists intensity_tier text check (intensity_tier in ('low', 'moderate', 'high'));

-- ==========================================================================
-- Per-set targets: lets a coach give each individual set within an exercise
-- its own reps/weight (a pyramid: 12/10/8 reps at increasing weight),
-- instead of one shared prescribed_reps/prescribed_weight applied to every
-- set. Array of {reps, weight} objects, one per set, index 0 = set 1 - same
-- reps-stays-text (ranges, "45 sec" for timed exercises) / weight-stays-
-- numeric-or-null convention as the existing prescribed_reps/
-- prescribed_weight columns. Null on every row created before this - both
-- builder pages and the athlete dashboard fall back to the old single-value
-- columns when it's null, so nothing needs a backfill.
-- ==========================================================================
alter table training_exercises add column if not exists set_targets jsonb;
alter table program_exercises add column if not exists set_targets jsonb;

-- ==========================================================================
-- Exercise field flexibility: weight-tracking, timed, and unilateral are now
-- independent per exercise instead of one exclusive `type` choice - a
-- weighted timed hold needs both a kg field and a duration field at once,
-- which the old type='weights' XOR type='timed' logic couldn't represent.
-- `type` itself is untouched - it keeps its existing jobs (the freeform
-- coach-facing label, and gating the Plyometric foot_contacts/
-- intensity_tier fields above).
--
-- Backfill: only type='timed' currently hides the weight input (everything
-- else, including Plyometric and custom types, already shows reps+weight
-- today), so it's the only case that needs correcting away from the new
-- columns' defaults to keep every existing exercise behaving exactly as it
-- does right now.
-- ==========================================================================
alter table exercises add column if not exists tracks_weight boolean not null default true;
alter table exercises add column if not exists is_timed boolean not null default false;
alter table exercises add column if not exists is_unilateral boolean not null default false;

update exercises set tracks_weight = false, is_timed = true where type = 'timed';

-- ==========================================================================
-- RLS PERFORMANCE FIX - the real cause of "canceling statement due to
-- statement timeout" and multi-second/never-finishing saves.
--
-- Confirmed live: while an athlete's set-save was stuck, pg_stat_activity
-- caught the actual INSERT into exercise_log_sets still ACTIVELY RUNNING
-- 28+ seconds in, with wait_event = null - meaning Postgres was genuinely
-- still computing, not stuck waiting on a lock (the earlier index fix
-- already ruled locks out) and not a network problem (the request had
-- reached the database and was executing).
--
-- Every policy in this file calls auth.uid()/auth.email() directly. Plain
-- function calls like that are allowed to be re-run by Postgres once per
-- row a policy has to check, instead of once for the whole query - and
-- auth.uid() has to parse the request's JWT out of a session setting every
-- single time it runs. Combined with the multi-table joins several
-- policies here use (e.g. exercise_log_sets -> program_exercises ->
-- program_days -> program_weeks -> programs), that's exactly the kind of
-- thing that turns a millisecond permission check into tens of seconds.
-- This is a well-known Supabase performance pitfall, not specific to this
-- app - their own docs recommend this exact fix:
-- https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
--
-- The fix: wrap every auth.uid()/auth.email() call in its own
-- `(select ...)`. That lets Postgres compute it ONCE per query and reuse
-- the cached result, instead of re-running it per row. Every policy below
-- is otherwise unchanged - same rules, same access, just computed
-- efficiently. Purely a performance fix, safe to re-run any time.
-- ==========================================================================

create or replace function public.is_coach()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'coach');
$$;

create or replace function public.claim_athlete_by_email()
returns bigint language plpgsql security definer set search_path = public as $$
declare matched_id bigint;
begin
  select id into matched_id from athletes
  where user_id is null and email is not null and lower(email) = lower((select auth.email()));
  if matched_id is null then
    raise exception 'no unclaimed athlete found for this email';
  end if;
  update athletes set user_id = (select auth.uid()) where id = matched_id;
  return matched_id;
end; $$;

drop policy if exists "select own profile" on profiles;
create policy "select own profile" on profiles for select using (id = (select auth.uid()));
drop policy if exists "update own profile" on profiles;
create policy "update own profile" on profiles for update using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "coach manages own exercise library" on exercises;
create policy "coach manages own exercise library" on exercises for all
  using (coach_id = (select auth.uid())) with check (coach_id = (select auth.uid()) and is_coach());
drop policy if exists "athlete views own coach's exercises" on exercises;
create policy "athlete views own coach's exercises" on exercises for select
  using (exists (select 1 from athletes a where a.user_id = (select auth.uid()) and a.coach_id = exercises.coach_id));

drop policy if exists "coach manages own programs" on programs;
create policy "coach manages own programs" on programs for all
  using (
    coach_id = (select auth.uid())
    and (
      athlete_id is null
      or exists (select 1 from athletes a where a.id = programs.athlete_id and a.coach_id = (select auth.uid()))
    )
  )
  with check (
    coach_id = (select auth.uid()) and is_coach()
    and (
      (is_template and athlete_id is null)
      or (not is_template and athlete_id is not null
          and exists (select 1 from athletes a where a.id = programs.athlete_id and a.coach_id = (select auth.uid())))
    )
  );
drop policy if exists "athlete views own programs" on programs;
create policy "athlete views own programs" on programs for select
  using (exists (select 1 from athletes a where a.id = programs.athlete_id and a.user_id = (select auth.uid())));

drop policy if exists "coach manages own program weeks" on program_weeks;
create policy "coach manages own program weeks" on program_weeks for all
  using (exists (select 1 from programs p where p.id = program_weeks.program_id and p.coach_id = (select auth.uid())))
  with check (exists (select 1 from programs p where p.id = program_weeks.program_id and p.coach_id = (select auth.uid())));
drop policy if exists "athlete views own program weeks" on program_weeks;
create policy "athlete views own program weeks" on program_weeks for select
  using (exists (select 1 from programs p join athletes a on a.id = p.athlete_id
                 where p.id = program_weeks.program_id and a.user_id = (select auth.uid())));

drop policy if exists "coach manages own program days" on program_days;
create policy "coach manages own program days" on program_days for all
  using (exists (select 1 from program_weeks w join programs p on p.id = w.program_id
                 where w.id = program_days.week_id and p.coach_id = (select auth.uid())))
  with check (exists (select 1 from program_weeks w join programs p on p.id = w.program_id
                 where w.id = program_days.week_id and p.coach_id = (select auth.uid())));
drop policy if exists "athlete views own program days" on program_days;
create policy "athlete views own program days" on program_days for select
  using (exists (select 1 from program_weeks w join programs p on p.id = w.program_id join athletes a on a.id = p.athlete_id
                 where w.id = program_days.week_id and a.user_id = (select auth.uid())));

drop policy if exists "coach manages own program exercises" on program_exercises;
create policy "coach manages own program exercises" on program_exercises for all
  using (exists (select 1 from program_days d join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id
                 where d.id = program_exercises.day_id and p.coach_id = (select auth.uid())))
  with check (exists (select 1 from program_days d join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id
                 where d.id = program_exercises.day_id and p.coach_id = (select auth.uid())));
drop policy if exists "athlete views own program exercises" on program_exercises;
create policy "athlete views own program exercises" on program_exercises for select
  using (exists (select 1 from program_days d join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id join athletes a on a.id = p.athlete_id
                 where d.id = program_exercises.day_id and a.user_id = (select auth.uid())));

drop policy if exists "coach full access to own athletes" on athletes;
create policy "coach full access to own athletes" on athletes for all
  using (coach_id = (select auth.uid())) with check (coach_id = (select auth.uid()));
drop policy if exists "athlete can view own row" on athletes;
create policy "athlete can view own row" on athletes for select using (user_id = (select auth.uid()));
drop policy if exists "athlete updates own settings" on athletes;
create policy "athlete updates own settings" on athletes for update
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "coach manages own athletes athlete_metrics" on athlete_metrics;
create policy "coach manages own athletes athlete_metrics" on athlete_metrics for all
  using (exists (select 1 from athletes a where a.id = athlete_metrics.athlete_id and a.coach_id = (select auth.uid())))
  with check (exists (select 1 from athletes a where a.id = athlete_metrics.athlete_id and a.coach_id = (select auth.uid())));

drop policy if exists "coach manages own athletes measurements" on measurements;
create policy "coach manages own athletes measurements" on measurements for all
  using (exists (select 1 from athletes a where a.id = measurements.athlete_id and a.coach_id = (select auth.uid())))
  with check (exists (select 1 from athletes a where a.id = measurements.athlete_id and a.coach_id = (select auth.uid())));

drop policy if exists "coach manages own athletes bodyweight" on bodyweight;
create policy "coach manages own athletes bodyweight" on bodyweight for all
  using (exists (select 1 from athletes a where a.id = bodyweight.athlete_id and a.coach_id = (select auth.uid())))
  with check (exists (select 1 from athletes a where a.id = bodyweight.athlete_id and a.coach_id = (select auth.uid())));

drop policy if exists "coach manages own athletes notes" on athlete_notes;
create policy "coach manages own athletes notes" on athlete_notes for all
  using (exists (select 1 from athletes a where a.id = athlete_notes.athlete_id and a.coach_id = (select auth.uid())))
  with check (exists (select 1 from athletes a where a.id = athlete_notes.athlete_id and a.coach_id = (select auth.uid())));

drop policy if exists "coach manages own trainings" on trainings;
create policy "coach manages own trainings" on trainings for all
  using (coach_id = (select auth.uid())) with check (coach_id = (select auth.uid()));

drop policy if exists "coach manages own training exercises" on training_exercises;
create policy "coach manages own training exercises" on training_exercises for all
  using (exists (select 1 from trainings t where t.id = training_exercises.training_id and t.coach_id = (select auth.uid())))
  with check (exists (select 1 from trainings t where t.id = training_exercises.training_id and t.coach_id = (select auth.uid())));

drop policy if exists "coach views log sets for own athletes" on exercise_log_sets;
create policy "coach views log sets for own athletes" on exercise_log_sets for select
  using (exists (select 1 from athletes a where a.id = exercise_log_sets.athlete_id and a.coach_id = (select auth.uid())));
drop policy if exists "athlete manages own log sets" on exercise_log_sets;
create policy "athlete manages own log sets" on exercise_log_sets for all
  using (exists (select 1 from athletes a where a.id = exercise_log_sets.athlete_id and a.user_id = (select auth.uid())))
  with check (
    exists (select 1 from athletes a where a.id = exercise_log_sets.athlete_id and a.user_id = (select auth.uid()))
    and exists (select 1 from program_exercises pe join program_days d on d.id = pe.day_id
                join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id
                where pe.id = exercise_log_sets.program_exercise_id and p.athlete_id = exercise_log_sets.athlete_id)
  );

drop policy if exists "coach views sessions for own athletes" on workout_sessions;
create policy "coach views sessions for own athletes" on workout_sessions for select
  using (exists (select 1 from athletes a where a.id = workout_sessions.athlete_id and a.coach_id = (select auth.uid())));
drop policy if exists "athlete manages own sessions" on workout_sessions;
create policy "athlete manages own sessions" on workout_sessions for all
  using (exists (select 1 from athletes a where a.id = workout_sessions.athlete_id and a.user_id = (select auth.uid())))
  with check (
    exists (select 1 from athletes a where a.id = workout_sessions.athlete_id and a.user_id = (select auth.uid()))
    and exists (select 1 from program_days d join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id
                where d.id = workout_sessions.program_day_id and p.athlete_id = workout_sessions.athlete_id)
  );

-- ==========================================================================
-- REAL FIX for "canceling statement due to statement timeout" - confirmed
-- via EXPLAIN ANALYZE that the query itself is fast in isolation (~10-80ms)
-- and the Postgres error logs confirmed every single failure is the same
-- 8-second statement_timeout being hit, consistently, not intermittently.
-- The gap between "fast in isolation" and "always times out for real":
--
-- Several tables' RLS policies check ownership by querying ANOTHER table
-- that ALSO has RLS enabled - e.g. exercise_log_sets' policy joins through
-- program_exercises -> program_days -> program_weeks -> programs. Each of
-- those tables has its OWN "coach manages own X" / "athlete views own X"
-- policy, and a plain query against an RLS-enabled table always re-runs
-- that table's own policy - so the permission check doesn't just add one
-- lookup per join level, it RE-RUNS THE FULL PERMISSION LOGIC of every
-- level below it, every time. Confirmed directly: EXPLAIN ANALYZE on a
-- single-row update showed the exact same "is this your athlete?" check
-- repeated over 30 times for ONE row. That's fine on a near-empty table
-- (the whole thing still finished in ~80ms during testing) but explodes
-- as real data grows - which is exactly why it now fails 100% of the time
-- instead of "sometimes."
--
-- The fix: SECURITY DEFINER helper functions, same pattern this file
-- already uses for is_coach() (line 39). A SECURITY DEFINER function runs
-- with its owner's privileges, which bypasses RLS for whatever it queries
-- internally - same principle as a table owner never being subject to
-- their own table's RLS. That breaks the recursive "policy re-triggers
-- policy re-triggers policy" chain entirely: each ownership check now
-- happens exactly ONCE, as a plain indexed join, no matter how many tables
-- deep the relationship is. Every function below does the EXACT SAME
-- logical check the policies were already doing - this changes how fast
-- it's computed, not who can access what.
-- ==========================================================================

create or replace function public.is_own_athlete_as_athlete(check_athlete_id bigint)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from athletes where id = check_athlete_id and user_id = (select auth.uid()));
$$;

create or replace function public.is_own_athlete_as_coach(check_athlete_id bigint)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from athletes where id = check_athlete_id and coach_id = (select auth.uid()));
$$;

create or replace function public.coach_owns_program(check_program_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from programs where id = check_program_id and coach_id = (select auth.uid()));
$$;

create or replace function public.athlete_owns_program(check_program_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from programs p join athletes a on a.id = p.athlete_id
    where p.id = check_program_id and a.user_id = (select auth.uid())
  );
$$;

create or replace function public.coach_owns_program_week(check_week_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from program_weeks w join programs p on p.id = w.program_id
    where w.id = check_week_id and p.coach_id = (select auth.uid())
  );
$$;

create or replace function public.athlete_owns_program_week(check_week_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from program_weeks w join programs p on p.id = w.program_id join athletes a on a.id = p.athlete_id
    where w.id = check_week_id and a.user_id = (select auth.uid())
  );
$$;

create or replace function public.coach_owns_program_day(check_day_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from program_days d join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id
    where d.id = check_day_id and p.coach_id = (select auth.uid())
  );
$$;

create or replace function public.athlete_owns_program_day(check_day_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from program_days d join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id join athletes a on a.id = p.athlete_id
    where d.id = check_day_id and a.user_id = (select auth.uid())
  );
$$;

-- These two are data-integrity checks, not permission checks - they verify
-- the athlete_id column being written on the row actually matches the
-- program this program_exercise/program_day belongs to (so an athlete
-- can't log a set against someone else's program_exercise id). Takes the
-- athlete_id explicitly rather than reading auth.uid() itself, since the
-- caller (the policy below) already separately confirmed auth.uid() owns
-- that athlete_id via is_own_athlete_as_athlete().
create or replace function public.program_exercise_matches_athlete(check_pe_id uuid, check_athlete_id bigint)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from program_exercises pe
    join program_days d on d.id = pe.day_id
    join program_weeks w on w.id = d.week_id
    join programs p on p.id = w.program_id
    where pe.id = check_pe_id and p.athlete_id = check_athlete_id
  );
$$;

create or replace function public.program_day_matches_athlete(check_day_id uuid, check_athlete_id bigint)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from program_days d
    join program_weeks w on w.id = d.week_id
    join programs p on p.id = w.program_id
    where d.id = check_day_id and p.athlete_id = check_athlete_id
  );
$$;

-- Rewrite every policy that had a multi-table join through another
-- RLS-protected table to call the helpers above instead - same access
-- rules as before, just computed once instead of recursively.

drop policy if exists "coach manages own program weeks" on program_weeks;
create policy "coach manages own program weeks" on program_weeks for all
  using (coach_owns_program(program_id)) with check (coach_owns_program(program_id));
drop policy if exists "athlete views own program weeks" on program_weeks;
create policy "athlete views own program weeks" on program_weeks for select
  using (athlete_owns_program(program_id));

drop policy if exists "coach manages own program days" on program_days;
create policy "coach manages own program days" on program_days for all
  using (coach_owns_program_week(week_id)) with check (coach_owns_program_week(week_id));
drop policy if exists "athlete views own program days" on program_days;
create policy "athlete views own program days" on program_days for select
  using (athlete_owns_program_week(week_id));

drop policy if exists "coach manages own program exercises" on program_exercises;
create policy "coach manages own program exercises" on program_exercises for all
  using (coach_owns_program_day(day_id)) with check (coach_owns_program_day(day_id));
drop policy if exists "athlete views own program exercises" on program_exercises;
create policy "athlete views own program exercises" on program_exercises for select
  using (athlete_owns_program_day(day_id));

drop policy if exists "coach views log sets for own athletes" on exercise_log_sets;
create policy "coach views log sets for own athletes" on exercise_log_sets for select
  using (is_own_athlete_as_coach(athlete_id));
drop policy if exists "athlete manages own log sets" on exercise_log_sets;
create policy "athlete manages own log sets" on exercise_log_sets for all
  using (is_own_athlete_as_athlete(athlete_id))
  with check (
    is_own_athlete_as_athlete(athlete_id)
    and program_exercise_matches_athlete(program_exercise_id, athlete_id)
  );

drop policy if exists "coach views sessions for own athletes" on workout_sessions;
create policy "coach views sessions for own athletes" on workout_sessions for select
  using (is_own_athlete_as_coach(athlete_id));
drop policy if exists "athlete manages own sessions" on workout_sessions;
create policy "athlete manages own sessions" on workout_sessions for all
  using (is_own_athlete_as_athlete(athlete_id))
  with check (
    is_own_athlete_as_athlete(athlete_id)
    and program_day_matches_athlete(program_day_id, athlete_id)
  );

-- ==========================================================================
-- Athlete self-logged workouts (Strength + Field/Training) + mobility
-- sessions. Lets an athlete log their own workout on any day (gated by a
-- new per-athlete coach setting) or a quick mobility/stretching session
-- (always allowed, doesn't touch programs/program_exercises at all).
-- ==========================================================================

alter table athletes add column if not exists can_self_log_workouts boolean not null default false;
alter table programs add column if not exists created_by_athlete boolean not null default false;

create or replace function public.athlete_can_self_log(check_athlete_id bigint)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from athletes where id = check_athlete_id and user_id = (select auth.uid()) and can_self_log_workouts = true);
$$;

-- athlete_owns_program*() only check "is this my program" - equally true of
-- a coach-assigned program, so they can't gate writes. These variants also
-- require created_by_athlete = true.
create or replace function public.athlete_owns_self_logged_program(check_program_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from programs p join athletes a on a.id = p.athlete_id
    where p.id = check_program_id and a.user_id = (select auth.uid()) and p.created_by_athlete = true);
$$;

create or replace function public.athlete_owns_self_logged_program_week(check_week_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from program_weeks w join programs p on p.id = w.program_id join athletes a on a.id = p.athlete_id
    where w.id = check_week_id and a.user_id = (select auth.uid()) and p.created_by_athlete = true);
$$;

create or replace function public.athlete_owns_self_logged_program_day(check_day_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from program_days d join program_weeks w on w.id = d.week_id join programs p on p.id = w.program_id join athletes a on a.id = p.athlete_id
    where d.id = check_day_id and a.user_id = (select auth.uid()) and p.created_by_athlete = true);
$$;

drop policy if exists "athlete creates own self-logged programs" on programs;
create policy "athlete creates own self-logged programs" on programs for insert
  with check (
    is_own_athlete_as_athlete(athlete_id) and athlete_can_self_log(athlete_id)
    and is_adhoc = true and not is_template and created_by_athlete = true
    and coach_id = (select coach_id from athletes where id = athlete_id)
  );

drop policy if exists "athlete deletes own self-logged programs" on programs;
create policy "athlete deletes own self-logged programs" on programs for delete
  using (is_own_athlete_as_athlete(athlete_id) and created_by_athlete = true);

drop policy if exists "athlete manages own self-logged program weeks" on program_weeks;
create policy "athlete manages own self-logged program weeks" on program_weeks for all
  using (athlete_owns_self_logged_program_week(id))
  with check (athlete_owns_self_logged_program(program_id));

drop policy if exists "athlete manages own self-logged program days" on program_days;
create policy "athlete manages own self-logged program days" on program_days for all
  using (athlete_owns_self_logged_program_day(id))
  with check (athlete_owns_self_logged_program_week(week_id));

drop policy if exists "athlete manages own self-logged program exercises" on program_exercises;
create policy "athlete manages own self-logged program exercises" on program_exercises for all
  using (athlete_owns_self_logged_program_day(day_id))
  with check (athlete_owns_self_logged_program_day(day_id));

-- ---- Mobility sessions (no programs/program_days involved) ----

alter table workout_sessions add column if not exists session_type text not null default 'training'
  check (session_type in ('training', 'mobility'));
alter table workout_sessions alter column program_day_id drop not null;

alter table workout_sessions drop constraint if exists workout_sessions_training_needs_day;
alter table workout_sessions add constraint workout_sessions_training_needs_day
  check (session_type <> 'training' or program_day_id is not null);

drop policy if exists "athlete manages own sessions" on workout_sessions;
create policy "athlete manages own sessions" on workout_sessions for all
  using (is_own_athlete_as_athlete(athlete_id))
  with check (
    is_own_athlete_as_athlete(athlete_id)
    and (
      (session_type = 'training' and program_day_matches_athlete(program_day_id, athlete_id))
      or (session_type = 'mobility' and program_day_id is null)
    )
  );

-- ==========================================================================
-- Section Library: a reusable, coach-managed GROUP of exercises (e.g.
-- "Warm-up A") that can be bulk-inserted into a Training or a Program/
-- calendar day. Same shape as trainings/training_exercises on purpose - a
-- section is really "a training-shaped block that gets pasted into
-- something else."
-- ==========================================================================
create table if not exists sections (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id),
  name text not null,
  created_at timestamptz not null default now()
);
alter table sections enable row level security;
drop policy if exists "coach manages own sections" on sections;
create policy "coach manages own sections" on sections for all
  using (coach_id = (select auth.uid())) with check (coach_id = (select auth.uid()));

create table if not exists section_exercises (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references sections(id) on delete cascade,
  exercise_id uuid not null references exercises(id),
  order_index int not null default 0,
  prescribed_sets int,
  prescribed_reps text,
  prescribed_weight numeric,
  rest_seconds int,
  extra_fields jsonb,
  notes text,
  set_targets jsonb,
  created_at timestamptz not null default now()
);
alter table section_exercises enable row level security;
drop policy if exists "coach manages own section exercises" on section_exercises;
create policy "coach manages own section exercises" on section_exercises for all
  using (exists (select 1 from sections s where s.id = section_exercises.section_id and s.coach_id = (select auth.uid())))
  with check (exists (select 1 from sections s where s.id = section_exercises.section_id and s.coach_id = (select auth.uid())));

create index if not exists idx_sections_coach_id on sections(coach_id);
create index if not exists idx_section_exercises_section_id on section_exercises(section_id);

-- ==========================================================================
-- section_label: a plain-text SNAPSHOT of the section's name, stamped onto
-- every exercise row copied out of a section at insert time - not a live
-- FK, same "clone, don't link" convention as cloneTemplateToAthlete (editing
-- the Section Library later never changes an already-built training/day).
-- Null on manually/individually added exercises.
--
-- superset_group_id: links exactly two rows as a linked superset. Generated
-- client-side (crypto.randomUUID()) when a coach links two cards, shared by
-- both linked rows - a plain shared value instead of a self-referencing FK
-- since the relationship is naturally symmetric. Partner lookup is done by
-- scanning the exercise list already loaded into memory (same convention as
-- findPE/findScheduledPE elsewhere in this app), not a separate query.
-- ==========================================================================
alter table training_exercises add column if not exists section_label text;
alter table program_exercises add column if not exists section_label text;
alter table training_exercises add column if not exists superset_group_id uuid;
alter table program_exercises add column if not exists superset_group_id uuid;

-- ==========================================================================
-- Stretch Library: coach-owned, reusable flat content list (mirrors
-- exercises' shape/RLS exactly) used by the guided Daily Mobility/
-- Stretching flow. body_areas is a text[] so an athlete's 1-2 focus areas
-- can be matched with a simple && overlap check - no separate tag join
-- table, same reasoning as exercises.category being a bare string.
-- ==========================================================================
create table if not exists stretches (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id),
  name text not null,
  body_areas text[] not null default '{}',
  video_url text,
  default_hold_seconds int not null default 30,
  created_at timestamptz not null default now()
);
alter table stretches enable row level security;

drop policy if exists "coach manages own stretch library" on stretches;
create policy "coach manages own stretch library" on stretches for all
  using (coach_id = (select auth.uid())) with check (coach_id = (select auth.uid()) and is_coach());

drop policy if exists "athlete views own coach's stretches" on stretches;
create policy "athlete views own coach's stretches" on stretches for select
  using (exists (select 1 from athletes a where a.user_id = (select auth.uid()) and a.coach_id = stretches.coach_id));

create index if not exists idx_stretches_coach_id on stretches(coach_id);
create index if not exists idx_stretches_body_areas on stretches using gin(body_areas);

-- ==========================================================================
-- athlete_stretch_preferences: a standing like/dislike per athlete per
-- stretch, independent of any one session. No 'neutral' value is ever
-- stored - tapping an already-active like/dislike again just deletes the
-- row. on delete cascade on both FKs means deleting a stretch or an
-- athlete cleans these up for free.
-- ==========================================================================
create table if not exists athlete_stretch_preferences (
  id uuid primary key default gen_random_uuid(),
  athlete_id bigint not null references athletes(id) on delete cascade,
  stretch_id uuid not null references stretches(id) on delete cascade,
  preference text not null check (preference in ('liked', 'disliked')),
  created_at timestamptz not null default now(),
  unique (athlete_id, stretch_id)
);
alter table athlete_stretch_preferences enable row level security;

drop policy if exists "athlete manages own stretch preferences" on athlete_stretch_preferences;
create policy "athlete manages own stretch preferences" on athlete_stretch_preferences for all
  using (is_own_athlete_as_athlete(athlete_id))
  with check (is_own_athlete_as_athlete(athlete_id));

create index if not exists idx_athlete_stretch_prefs_athlete_id on athlete_stretch_preferences(athlete_id);

-- ==========================================================================
-- Storage: public bucket for self-hosted stretch clips. Path convention is
-- {coach_id}/{uuid}.{ext} - storage.foldername(name) splits an object path
-- into folder segments, so foldername(name)[1] is the coach_id folder for
-- any object in this bucket, scoping writes to the owning coach without a
-- separate ownership table.
-- ==========================================================================
insert into storage.buckets (id, name, public)
values ('stretch-videos', 'stretch-videos', true)
on conflict (id) do nothing;

drop policy if exists "coach manages own stretch videos" on storage.objects;
create policy "coach manages own stretch videos" on storage.objects for all
  using (bucket_id = 'stretch-videos' and (select auth.uid())::text = (storage.foldername(name))[1])
  with check (bucket_id = 'stretch-videos' and (select auth.uid())::text = (storage.foldername(name))[1] and is_coach());

drop policy if exists "public reads stretch videos" on storage.objects;
create policy "public reads stretch videos" on storage.objects for select
  using (bucket_id = 'stretch-videos');

-- ==========================================================================
-- Athlete status labels: archived is the only new column needed - Active/
-- Pending/Offline are all already derivable from existing columns
-- (user_id/email), computed client-side in athleteStatus(). No RLS change:
-- "coach full access to own athletes" is already FOR ALL, not column-scoped.
-- ==========================================================================
alter table athletes add column if not exists archived boolean not null default false;

-- ==========================================================================
-- Optional avg heart rate on a self-logged Field/Training session (bpm).
-- Sanity-bounded, not required - null just means the athlete didn't have/
-- use a heart rate monitor for that session.
-- ==========================================================================
alter table workout_sessions add column if not exists avg_heart_rate int
  check (avg_heart_rate is null or avg_heart_rate between 30 and 250);

-- ==========================================================================
-- Athlete-side exercise flexibility on coach-assigned workouts: two
-- separate per-athlete toggles (add extra exercises / swap a prescribed
-- one), plus tracking columns on program_exercises so the coach can see
-- when their program was touched. Additive to the existing "coach manages
-- own program exercises" (all) and "athlete views own program exercises"
-- (select) policies - Postgres OR's multiple permissive policies together,
-- so these only add new allowed cases without touching what's already
-- there.
-- ==========================================================================
alter table athletes add column if not exists can_add_exercises boolean not null default false;
alter table athletes add column if not exists can_change_exercises boolean not null default false;

alter table program_exercises add column if not exists added_by_athlete boolean not null default false;
alter table program_exercises add column if not exists swapped_by_athlete boolean not null default false;
alter table program_exercises add column if not exists original_exercise_id uuid references exercises(id);

create or replace function public.athlete_owns_program_day(check_day_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from program_days d join program_weeks w on w.id = d.week_id
    join programs p on p.id = w.program_id join athletes a on a.id = p.athlete_id
    where d.id = check_day_id and a.user_id = (select auth.uid())
  );
$$;

create or replace function public.athlete_can_add_exercises_to_day(check_day_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from program_days d join program_weeks w on w.id = d.week_id
    join programs p on p.id = w.program_id join athletes a on a.id = p.athlete_id
    where d.id = check_day_id and a.user_id = (select auth.uid()) and a.can_add_exercises = true
  );
$$;

create or replace function public.athlete_can_change_exercises_on_day(check_day_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from program_days d join program_weeks w on w.id = d.week_id
    join programs p on p.id = w.program_id join athletes a on a.id = p.athlete_id
    where d.id = check_day_id and a.user_id = (select auth.uid()) and a.can_change_exercises = true
  );
$$;

drop policy if exists "athlete adds extra exercises when allowed" on program_exercises;
create policy "athlete adds extra exercises when allowed" on program_exercises for insert
  with check (athlete_can_add_exercises_to_day(day_id));

drop policy if exists "athlete swaps exercises when allowed" on program_exercises;
create policy "athlete swaps exercises when allowed" on program_exercises for update
  using (athlete_can_change_exercises_on_day(day_id))
  with check (athlete_can_change_exercises_on_day(day_id));

drop policy if exists "athlete deletes own added exercises" on program_exercises;
create policy "athlete deletes own added exercises" on program_exercises for delete
  using (added_by_athlete = true and athlete_owns_program_day(day_id));

-- ==========================================================================
-- RPE 9-10 follow-up: when a session's effort rating is very high, the
-- athlete is asked whether that's because it was just heavy/tiring or
-- because of pain/injury - if pain/injury, a short note. reviewed_at lets
-- the coach acknowledge a report (clearing it from their Overview inbox)
-- without deleting the history, which still shows read-only on the
-- Calendar day detail. The coach previously had no UPDATE policy on
-- workout_sessions at all (SELECT only) - this adds one, row-level only
-- like every other write policy in this file, not column-scoped.
-- ==========================================================================
alter table workout_sessions add column if not exists rpe_flag_reason text check (rpe_flag_reason in ('pain_injury', 'heavy_tiring'));
alter table workout_sessions add column if not exists rpe_flag_note text;
alter table workout_sessions add column if not exists rpe_flag_reviewed_at timestamptz;

drop policy if exists "coach reviews sessions for own athletes" on workout_sessions;
create policy "coach reviews sessions for own athletes" on workout_sessions for update
  using (exists (select 1 from athletes a where a.id = workout_sessions.athlete_id and a.coach_id = (select auth.uid())))
  with check (exists (select 1 from athletes a where a.id = workout_sessions.athlete_id and a.coach_id = (select auth.uid())));

-- ==========================================================================
-- Supersets inside a Section: training_exercises/program_exercises already
-- have superset_group_id (shared by the linked rows), but section_exercises
-- never got it since sections didn't support supersets. No RLS change
-- needed - already covered by the existing "coach manages own section
-- exercises" FOR ALL policy, which isn't column-scoped.
-- ==========================================================================
alter table section_exercises add column if not exists superset_group_id uuid;

-- ==========================================================================
-- Sections stay together as one locked block when reordering: every
-- exercise copied out of a section in one "Add Section" action shares a
-- fresh section_instance_id, stamped by the 3 insert-section clone
-- functions alongside the existing section_label text. Unlike
-- section_label (just display text, could collide if the same section is
-- inserted twice), this id is unique per insertion, so two copies of the
-- same section can be dragged independently. No RLS change needed - same
-- reasoning as superset_group_id above.
-- ==========================================================================
alter table training_exercises add column if not exists section_instance_id uuid;
alter table program_exercises add column if not exists section_instance_id uuid;

-- ==========================================================================
-- Athlete-side workout rescheduling. A scheduled day's calendar date is
-- normally derived (start_date + week_number + day_number) - date_override,
-- when set, wins over that computed date at every place that resolves a
-- day's dateStr. Gated by a new per-athlete coach toggle, same pattern as
-- can_add_exercises/can_change_exercises. Row-level, not column-scoped -
-- same accepted simplification as those two: an athlete with this toggle on
-- could technically update other program_days columns via a raw API call,
-- not just date_override, consistent with this app's existing threat model.
-- ==========================================================================
alter table program_days add column if not exists date_override date;
alter table athletes add column if not exists can_reschedule_workouts boolean not null default false;

create or replace function public.athlete_can_reschedule_day(check_day_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from program_days d join program_weeks w on w.id = d.week_id
    join programs p on p.id = w.program_id join athletes a on a.id = p.athlete_id
    where d.id = check_day_id and a.user_id = (select auth.uid()) and a.can_reschedule_workouts = true
  );
$$;

drop policy if exists "athlete reschedules days when allowed" on program_days;
create policy "athlete reschedules days when allowed" on program_days for update
  using (athlete_can_reschedule_day(id))
  with check (athlete_can_reschedule_day(id));

-- ==========================================================================
-- Athlete-facing Weekly Stats view (pick one of the last 8 weeks, see
-- workouts completed/volume/training time/PRs for it) - purely a read of
-- data already loaded client-side, no new tables. Defaults to true, unlike
-- every other athlete-permission toggle in this file, so a brand-new
-- athlete has Stats available immediately without the coach needing to
-- remember to turn it on - the coach can still switch it off per-athlete.
-- ==========================================================================
alter table athletes add column if not exists can_view_weekly_stats boolean not null default true;

-- ==========================================================================
-- Distance (meters) logging field - a 4th independent exercise-level toggle
-- alongside tracks_weight/is_timed/is_unilateral, off by default. No RLS
-- change needed on either column (both already covered by existing
-- policies on exercises/exercise_log_sets).
-- ==========================================================================
alter table exercises add column if not exists tracks_distance boolean not null default false;
alter table exercise_log_sets add column if not exists actual_distance numeric;

-- ==========================================================================
-- Upcoming Tournaments - athlete-added (name, date, 1-5 importance rating),
-- visible on both the athlete's week strip and the coach's month calendar.
-- Coach gets read-only access; only the athlete ever writes their own rows.
-- ==========================================================================
create table if not exists tournaments (
  id uuid primary key default gen_random_uuid(),
  athlete_id bigint not null references athletes(id) on delete cascade,
  name text not null,
  date date not null,
  importance int not null check (importance between 1 and 5),
  created_at timestamptz not null default now()
);
alter table tournaments enable row level security;

drop policy if exists "athlete manages own tournaments" on tournaments;
create policy "athlete manages own tournaments" on tournaments for all
  using (is_own_athlete_as_athlete(athlete_id))
  with check (is_own_athlete_as_athlete(athlete_id));

drop policy if exists "coach views own athletes' tournaments" on tournaments;
create policy "coach views own athletes' tournaments" on tournaments for select
  using (is_own_athlete_as_coach(athlete_id));

create index if not exists idx_tournaments_athlete_id on tournaments(athlete_id);
create index if not exists idx_tournaments_date on tournaments(date);

-- ==========================================================================
-- Lets an athlete read their own coach's name (for the new athlete-app
-- Profile tab) - additive to "select own profile" (Postgres OR's multiple
-- permissive select policies together), so this only ever widens what an
-- athlete can see, never what a coach can see of anyone else's profile.
-- ==========================================================================
drop policy if exists "athlete views own coach's profile" on profiles;
create policy "athlete views own coach's profile" on profiles for select
  using (exists (select 1 from athletes a where a.coach_id = profiles.id and a.user_id = (select auth.uid())));

-- ==========================================================================
-- Fix timezone-dependent date bucketing: workout_sessions.started_at is a
-- UTC instant, and several places were converting it to a calendar date via
-- new Date(started_at) in whichever browser happened to be running - so the
-- same session could land under a different date on the coach's calendar
-- than on the athlete's own week strip, depending on each person's local
-- timezone. local_date is written once, by the athlete's own device, at the
-- moment each session is created (see the 3 workout_sessions insert sites
-- in athlete-app/dashboard.js) - every date-bucketing read site then uses
-- this fixed value instead of re-deriving one. Same "write the fixed value
-- once, read it back everywhere" pattern exercise_log_sets.date already
-- uses successfully.
-- ==========================================================================
alter table workout_sessions add column if not exists local_date date;

-- Best-effort backfill for existing rows - we can't know the athlete's exact
-- historical local day, so this falls back to the UTC calendar-date of
-- started_at (the same fallback already used ad hoc elsewhere in the app,
-- e.g. durationEvents' `s.started_at.split('T')[0]`), just made permanent.
update workout_sessions set local_date = (started_at at time zone 'utc')::date where local_date is null;
alter table workout_sessions alter column local_date set not null;

-- ==========================================================================
-- Coach notification bell: a per-coach feed of athlete activity (workout
-- added/completed, tournament added). Athletes insert their own rows -
-- their device already knows their own name and what just happened, so the
-- message is written once, pre-formatted, and read as-is everywhere (same
-- "write the fixed value once" reasoning as workout_sessions.local_date
-- above) - coaches read/mark-read/delete their own feed.
-- ==========================================================================
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id),
  athlete_id bigint references athletes(id) on delete set null,
  type text not null check (type in ('workout_added', 'workout_completed', 'tournament_added')),
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
alter table notifications enable row level security;

drop policy if exists "coach manages own notifications" on notifications;
create policy "coach manages own notifications" on notifications for all
  using (coach_id = (select auth.uid())) with check (coach_id = (select auth.uid()));

create or replace function public.athlete_notifies_own_coach(check_athlete_id bigint, target_coach_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from athletes where id = check_athlete_id and user_id = (select auth.uid()) and coach_id = target_coach_id
  );
$$;

drop policy if exists "athlete creates notifications for own coach" on notifications;
create policy "athlete creates notifications for own coach" on notifications for insert
  with check (athlete_notifies_own_coach(athlete_id, coach_id));

create index if not exists idx_notifications_coach_id on notifications(coach_id, created_at desc);
create index if not exists idx_notifications_unread on notifications(coach_id) where read_at is null;

-- ==========================================================================
-- Multi-day tournaments - "date" stays the start date (existing column,
-- existing index, no rename needed), "end_date" is new and defaults to the
-- same day for every pre-existing row (a single-day tournament is just a
-- range where start == end). The week strip / month calendar now mark
-- every day in [date, end_date], not just the start day.
-- ==========================================================================
alter table tournaments add column if not exists end_date date;
update tournaments set end_date = date where end_date is null;
alter table tournaments alter column end_date set not null;

alter table tournaments drop constraint if exists tournaments_end_after_start;
alter table tournaments add constraint tournaments_end_after_start check (end_date >= date);

create index if not exists idx_tournaments_end_date on tournaments(end_date);

-- ==========================================================================
-- Per-instance logging-field overrides. "Adjust Fields" (Workout Builder's
-- exercise card kebab menu) used to write straight to `exercises` - that
-- changed the field everywhere that exercise is used, which wasn't the
-- intent. These 4 nullable columns instead let ONE placement of an
-- exercise override tracks_weight/is_timed/is_unilateral/tracks_distance
-- for just that one workout - null means "use the exercise's own default"
-- (the normal case), non-null pins it regardless of what the Exercise
-- Library default is or later becomes. Added to both training_exercises
-- (Workout Builder's own table) and program_exercises (what an athlete
-- actually logs against) since a Training's overrides need to survive
-- being assigned onto a real athlete's calendar/program - see the updated
-- cloneTrainingToDay/cloneTemplateToAthlete in athlete-calendar.js.
-- ==========================================================================
alter table training_exercises add column if not exists tracks_weight_override boolean;
alter table training_exercises add column if not exists is_timed_override boolean;
alter table training_exercises add column if not exists is_unilateral_override boolean;
alter table training_exercises add column if not exists tracks_distance_override boolean;

alter table program_exercises add column if not exists tracks_weight_override boolean;
alter table program_exercises add column if not exists is_timed_override boolean;
alter table program_exercises add column if not exists is_unilateral_override boolean;
alter table program_exercises add column if not exists tracks_distance_override boolean;

-- ==========================================================================
-- Coach -> athlete messages. One row per recipient (fan-out at send time,
-- same shape notifications already uses) - "all athletes" or "specific
-- athletes" is just how many rows get inserted, no separate targeting
-- table needed. timing decides when the athlete-app shows it: 'on_open'
-- (next app open) or 'before_workout' (right before Start/Continue
-- Workout, gated in startWorkout() in athlete-app/dashboard.js). Real push
-- notifications are a deliberately separate, bigger project (needs a
-- service worker + a server-side piece to send) - not attempted here.
-- ==========================================================================
create table if not exists coach_messages (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id),
  athlete_id bigint not null references athletes(id) on delete cascade,
  message text not null,
  timing text not null check (timing in ('on_open', 'before_workout')),
  seen_at timestamptz,
  created_at timestamptz not null default now()
);
alter table coach_messages enable row level security;

drop policy if exists "coach manages own messages" on coach_messages;
create policy "coach manages own messages" on coach_messages for all
  using (coach_id = (select auth.uid())) with check (coach_id = (select auth.uid()));

drop policy if exists "athlete views own messages" on coach_messages;
create policy "athlete views own messages" on coach_messages for select
  using (is_own_athlete_as_athlete(athlete_id));

drop policy if exists "athlete marks own messages seen" on coach_messages;
create policy "athlete marks own messages seen" on coach_messages for update
  using (is_own_athlete_as_athlete(athlete_id))
  with check (is_own_athlete_as_athlete(athlete_id));

create index if not exists idx_coach_messages_unseen on coach_messages(athlete_id) where seen_at is null;
create index if not exists idx_coach_messages_coach_id on coach_messages(coach_id, created_at desc);

-- ==========================================================================
-- Real push notifications (Web Push / VAPID). One row per subscribed
-- device (coach or athlete - both are real auth.users rows, so one table
-- covers both sides). The send-push Edge Function reads this table with
-- the service role key (bypassing RLS) since it needs to push to a user
-- who isn't the caller - e.g. an athlete's action needs to notify their
-- coach. Athletes now also get a third message timing option ('push').
-- ==========================================================================
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;

drop policy if exists "user manages own push subscriptions" on push_subscriptions;
create policy "user manages own push subscriptions" on push_subscriptions for all
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create index if not exists idx_push_subscriptions_user_id on push_subscriptions(user_id);

alter table coach_messages drop constraint if exists coach_messages_timing_check;
alter table coach_messages add constraint coach_messages_timing_check
  check (timing in ('on_open', 'before_workout', 'push'));

-- ==========================================================================
-- Custom athlete labels (e.g. "Monthly Plan", "12 Week Plan") - the coach
-- creates their own label names, then tags any number of them onto any
-- athlete. Filtered from a checklist dropdown on the dashboard (index.html),
-- separate from the always-visible status filter since there can be many.
-- ==========================================================================
create table if not exists athlete_labels (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id),
  name text not null,
  created_at timestamptz not null default now()
);
alter table athlete_labels enable row level security;

drop policy if exists "coach manages own athlete labels" on athlete_labels;
create policy "coach manages own athlete labels" on athlete_labels for all
  using (coach_id = auth.uid()) with check (coach_id = auth.uid());

create table if not exists athlete_label_links (
  athlete_id bigint not null references athletes(id) on delete cascade,
  label_id uuid not null references athlete_labels(id) on delete cascade,
  primary key (athlete_id, label_id)
);
alter table athlete_label_links enable row level security;

drop policy if exists "coach manages own athlete label links" on athlete_label_links;
create policy "coach manages own athlete label links" on athlete_label_links for all
  using (exists (select 1 from athletes a where a.id = athlete_label_links.athlete_id and a.coach_id = auth.uid()))
  with check (exists (select 1 from athletes a where a.id = athlete_label_links.athlete_id and a.coach_id = auth.uid()));

-- ==========================================================================
-- Real two-way chat between a coach and one of their athletes - a genuine
-- persistent history, unlike coach_messages (that table is a one-shot
-- popup queue: fetched once with seen_at is null, marked seen immediately,
-- never fetchable again - not usable for a chat log). A message is either
-- text, a shared PDF report (pdf_url), or both.
-- ==========================================================================
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id),
  athlete_id bigint not null references athletes(id) on delete cascade,
  sender text not null check (sender in ('coach', 'athlete')),
  message text not null default '',
  pdf_url text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (message <> '' or pdf_url is not null)
);
alter table chat_messages enable row level security;

drop policy if exists "coach manages own chats" on chat_messages;
create policy "coach manages own chats" on chat_messages for all
  using (coach_id = auth.uid()) with check (coach_id = auth.uid());

drop policy if exists "athlete manages own chat" on chat_messages;
create policy "athlete manages own chat" on chat_messages for all
  using (exists (select 1 from athletes a where a.id = chat_messages.athlete_id and a.user_id = auth.uid()))
  with check (exists (select 1 from athletes a where a.id = chat_messages.athlete_id and a.user_id = auth.uid()));

create index if not exists idx_chat_messages_athlete on chat_messages(athlete_id, created_at);

-- Storage: public bucket for coach-shared PDF progress reports, same
-- {coach_id}/{uuid}.ext path convention (and same reasoning) as the
-- stretch-videos bucket above - only the coach ever uploads here (athletes
-- never generate reports), so no separate athlete-write policy is needed.
insert into storage.buckets (id, name, public)
values ('chat-attachments', 'chat-attachments', true)
on conflict (id) do nothing;

drop policy if exists "coach manages own chat attachments" on storage.objects;
create policy "coach manages own chat attachments" on storage.objects for all
  using (bucket_id = 'chat-attachments' and (select auth.uid())::text = (storage.foldername(name))[1])
  with check (bucket_id = 'chat-attachments' and (select auth.uid())::text = (storage.foldername(name))[1] and is_coach());

drop policy if exists "public reads chat attachments" on storage.objects;
create policy "public reads chat attachments" on storage.objects for select
  using (bucket_id = 'chat-attachments');

-- ==========================================================================
-- exercise_log_sets.weight_unit - remembers which unit (kg/lbs) the athlete
-- actually typed a set's weight in, since actual_weight is always stored
-- normalized to kg. Without this, the Exercise History modal in the
-- athlete app had to guess by re-applying the athlete's CURRENT
-- athletes.weight_unit preference at render time - so a set logged in kg
-- would silently redisplay as a converted lbs number (e.g. "220.5lbs"
-- instead of "100kg") the moment the athlete later switched their default
-- unit, even though nothing about that historical set actually changed.
-- Existing rows have no way to know what was typed at the time, so they're
-- left null and the app falls back to 'kg' (the actual stored unit) rather
-- than the athlete's current preference, which is the safer of the two
-- guesses.
-- ==========================================================================
alter table exercise_log_sets add column if not exists weight_unit text check (weight_unit in ('kg', 'lbs'));

-- ==========================================================================
-- scheduled_notifications - a short-lived queue for "push this to the
-- athlete/coach at a specific future time" (first use: the rest timer,
-- see scheduleRestTimerPush/cancelRestTimerPush in athlete-app/dashboard.js
-- and supabase/functions/send-due-notifications). Every OTHER push in this
-- app is sent immediately (sendPush() in push.js, called the moment
-- something happens) - this table exists because a rest timer needs to
-- notify LATER, at a moment the app has no code running at all if the
-- athlete has switched to another app. A separate cron job (set up in the
-- Supabase dashboard, not from this file - see this table's Edge Function
-- for the exact steps) checks this table every ~15 seconds and sends +
-- deletes anything due, so it works even if the athlete's browser tab is
-- fully backgrounded when the timer ends. Rows are always deleted once
-- handled (sent, or cancelled by the app, or too stale to bother sending)
-- - this is a queue, not a history log, so nothing here is meant to
-- persist.
-- ==========================================================================
create table if not exists scheduled_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fire_at timestamptz not null,
  title text not null,
  body text not null,
  url text,
  created_at timestamptz not null default now()
);
alter table scheduled_notifications enable row level security;

-- Same shape as push_subscriptions' policy - a user can schedule/cancel
-- their own pending notifications (the app does this when a rest timer
-- starts/stops), but the actual SENDING happens from the cron job's Edge
-- Function using the service role key, which bypasses RLS entirely since
-- it has to process every user's due rows, not just one.
drop policy if exists "user manages own scheduled notifications" on scheduled_notifications;
create policy "user manages own scheduled notifications" on scheduled_notifications for all
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create index if not exists idx_scheduled_notifications_fire_at on scheduled_notifications(fire_at);

-- ==========================================================================
-- Global coach on/off switch for the Daily Mobility/Stretching tile - lets a
-- coach hide it from every athlete at once while they haven't filmed any
-- stretch videos yet, without having to touch each athlete individually.
-- Lives on `profiles` (one row per coach) rather than `athletes`, since it's
-- a single coach-wide preference, not a per-athlete permission like the
-- can_* columns on athletes.
--
-- profiles already has a column-level grant restricting authenticated
-- updates to just the `name` column (line 53 above) - this column needs its
-- own explicit grant too, or the "update own profile" RLS policy passing
-- doesn't matter, Postgres blocks the column write before RLS is even
-- checked.
-- ==========================================================================
alter table profiles add column if not exists mobility_enabled boolean not null default true;
grant update (mobility_enabled) on profiles to authenticated;

-- ==========================================================================
-- extra_field_names: a coach's reusable library of "extra field" names
-- (RPE, % of 1RM, Tempo, ...) used by the Workout Builder's field picker -
-- pick an existing name or type a new one once, instead of retyping the
-- same field name on every exercise card. Same "small reusable library"
-- shape as exercises/sections, just a name with no other data. unique
-- (coach_id, name) makes adding a field the coach already has a no-op
-- upsert instead of a duplicate library entry.
-- ==========================================================================
create table if not exists extra_field_names (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (coach_id, name)
);
alter table extra_field_names enable row level security;
drop policy if exists "coach manages own extra field names" on extra_field_names;
create policy "coach manages own extra field names" on extra_field_names for all
  using (coach_id = (select auth.uid())) with check (coach_id = (select auth.uid()));
create index if not exists idx_extra_field_names_coach_id on extra_field_names(coach_id);

-- ==========================================================================
-- Workout Library labels - same shape as athlete_labels/athlete_label_links
-- (line 1468 above), just linking to trainings instead of athletes, so a
-- coach can tag workouts (e.g. "Inseason 2026") and filter the Workout
-- Library down to just that tag.
-- ==========================================================================
create table if not exists training_labels (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id),
  name text not null,
  created_at timestamptz not null default now()
);
alter table training_labels enable row level security;
drop policy if exists "coach manages own training labels" on training_labels;
create policy "coach manages own training labels" on training_labels for all
  using (coach_id = (select auth.uid())) with check (coach_id = (select auth.uid()));

create table if not exists training_label_links (
  training_id uuid not null references trainings(id) on delete cascade,
  label_id uuid not null references training_labels(id) on delete cascade,
  primary key (training_id, label_id)
);
alter table training_label_links enable row level security;
drop policy if exists "coach manages own training label links" on training_label_links;
create policy "coach manages own training label links" on training_label_links for all
  using (exists (select 1 from trainings t where t.id = training_label_links.training_id and t.coach_id = (select auth.uid())))
  with check (exists (select 1 from trainings t where t.id = training_label_links.training_id and t.coach_id = (select auth.uid())));

create index if not exists idx_training_labels_coach_id on training_labels(coach_id);
create index if not exists idx_training_label_links_training_id on training_label_links(training_id);

-- ==========================================================================
-- Alternative exercise: a coach-curated single fallback set in Workout
-- Builder (kebab menu -> Set Alternative Exercise) for when an athlete
-- can't do the prescribed exercise (no equipment, an injury) - shown as a
-- quick one-tap icon during the guided workout, distinct from the existing
-- free-search Swap button. Set on training_exercises (where the coach
-- builds it) and carried through to program_exercises by every clone path
-- that copies a training's/day's exercises onto a real athlete day
-- (cloneTrainingToDay, cloneDayToDate, cloneTemplateToAthlete - all three
-- in athlete-calendar.js). No RLS change needed - both tables' existing
-- "coach manages..."/"athlete manages..." policies aren't column-scoped.
-- ==========================================================================
alter table training_exercises add column if not exists alternative_exercise_id uuid references exercises(id);
alter table program_exercises add column if not exists alternative_exercise_id uuid references exercises(id);

-- ==========================================================================
-- Reps and Timed are independent now, instead of Timed replacing Reps
-- (an exercise can track sets/reps/weight AND a hold time at once, e.g.
-- "3 sets x 10 reps, each held 3 seconds" - previously only one of reps or
-- duration could ever be tracked, sharing the same reps/actual_reps column).
--
-- tracks_reps defaults true for every existing exercise (matches current
-- behavior for every non-timed exercise, which always tracked reps) - the
-- one backfill needed is turning it OFF for exercises that are already
-- is_timed=true, since under the OLD mutually-exclusive rule those never
-- tracked reps at all (Timed simply replaced the reps input with a timer).
-- Without this backfill, every existing timed exercise would suddenly
-- show an empty, meaningless "reps" box alongside its timer.
--
-- actual_duration is the new independent column for the logged hold time -
-- exercise_log_sets.actual_reps previously held EITHER a rep count or a
-- time string depending on is_timed, now actual_reps is always a real rep
-- count (or null) and actual_duration is always the real duration (or
-- null). Old logged rows keep their duration sitting in actual_reps
-- unmigrated - the app already knows to fall back to reading it from there
-- for any exercise that's timed and not (yet) tracking reps, so nothing
-- needs a data migration here.
-- ==========================================================================
alter table exercises add column if not exists tracks_reps boolean not null default true;
update exercises set tracks_reps = false where is_timed = true;

alter table exercise_log_sets add column if not exists actual_duration text;

-- ==========================================================================
-- Section Builder's exercise cards get the same kebab menu (Adjust Fields,
-- Adjust Exercise, Set Alternative Exercise) that Workout Builder already
-- has - section_exercises never got the columns those features need, since
-- they were only ever built against training_exercises/program_exercises.
-- Same column shapes, same "no RLS change needed" reasoning (see the
-- alternative_exercise_id block above) - "coach manages own section
-- exercises" isn't column-scoped either.
-- ==========================================================================
alter table section_exercises add column if not exists tracks_weight_override boolean;
alter table section_exercises add column if not exists is_timed_override boolean;
alter table section_exercises add column if not exists is_unilateral_override boolean;
alter table section_exercises add column if not exists tracks_distance_override boolean;
alter table section_exercises add column if not exists alternative_exercise_id uuid references exercises(id);

-- ==========================================================================
-- Deleting an exercise used to hard-fail (Postgres 23503) the moment it was
-- referenced by any training_exercises/program_exercises/section_exercises
-- row, since none of those FKs cascade - the coach had to go track down and
-- remove every reference by hand first. Now: template rows (training/section
-- library - no "done" concept) and not-yet-logged scheduled rows get
-- deleted along with it automatically; a scheduled row that already has
-- exercise_log_sets logged against it is left alone so the athlete's
-- history stays intact. The exercises row itself is never hard-deleted
-- anymore (archived instead) specifically so those surviving history rows
-- keep a valid, name-resolving reference - see deleteExercise() in
-- exercises.js. Archived exercises are filtered out of the Library and
-- every "add exercise" picker from here on, which is functionally the same
-- as being deleted. No RLS change needed - not column-scoped.
-- ==========================================================================
alter table exercises add column if not exists archived boolean not null default false;

-- ==========================================================================
-- Athlete profile photo - uploaded by the athlete themselves from their
-- app's Settings tab (see renderSettings()/resizeImageFile() in
-- athlete-app/dashboard.js), shown to the coach wherever initials used to
-- be (athlete grid, profile header, communication list). Storage policy is
-- the mirror image of chat-attachments/stretch-videos above: there the
-- COACH uploads under their own auth.uid() folder; here the ATHLETE
-- uploads under their own, so the check is against auth.uid() with no
-- is_coach() requirement. Fixed filename per athlete (not a fresh uuid per
-- upload) - the app always uploads with upsert:true, so a re-upload just
-- overwrites the same object instead of orphaning old photos in storage.
-- ==========================================================================
alter table athletes add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('athlete-avatars', 'athlete-avatars', true)
on conflict (id) do nothing;

drop policy if exists "athlete manages own avatar" on storage.objects;
create policy "athlete manages own avatar" on storage.objects for all
  using (bucket_id = 'athlete-avatars' and (select auth.uid())::text = (storage.foldername(name))[1])
  with check (bucket_id = 'athlete-avatars' and (select auth.uid())::text = (storage.foldername(name))[1]);

drop policy if exists "public reads athlete avatars" on storage.objects;
create policy "public reads athlete avatars" on storage.objects for select
  using (bucket_id = 'athlete-avatars');

-- ==========================================================================
-- First-time app intro (see enterAppMaybeIntro()/renderIntroStep() in
-- athlete-app/dashboard.js) - a few short screens shown once, right after
-- an athlete finishes their profile/password setup, explaining the basics
-- before they land on their real Week view. Backfilling every EXISTING
-- athlete to true (not the column's own false default) so nobody already
-- using the app gets surprised with an unexpected walkthrough on their next
-- login - only athletes created from here on start at false and actually
-- see it. No RLS change needed - not column-scoped.
-- ==========================================================================
alter table athletes add column if not exists intro_seen boolean not null default false;
update athletes set intro_seen = true where intro_seen = false;

-- ==========================================================================
-- stretches.is_unilateral - a coach films just ONE side of a two-sided
-- stretch (quad stretch, pigeon pose, figure-4, etc.) and flags it here.
-- buildMobilityQueue() in athlete-app/dashboard.js then queues it twice in
-- a row (same clip, mirrored horizontally the second time via CSS - see
-- loadStretchIntoVideo()), each pass getting the full hold duration, with
-- an "Other Side" label on the second. No RLS change needed - not
-- column-scoped.
-- ==========================================================================
alter table stretches add column if not exists is_unilateral boolean not null default false;

-- ==========================================================================
-- stretch_body_areas - coach-owned master list of targeted body areas, kept
-- separate from stretches.body_areas (which is just a text[] tag on each
-- individual stretch). Lets an area be created/renamed/deleted from the
-- Stretch Library's Manage Areas modal even before any stretch is tagged
-- with it - previously an area only "existed" once a stretch carried it,
-- and the starter suggestions (Hips, Hamstrings, etc.) were a fixed,
-- un-editable list baked into stretches.js. Same RLS shape as every other
-- coach-owned table (see is_coach() above).
-- ==========================================================================
create table if not exists stretch_body_areas (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (coach_id, name)
);

alter table stretch_body_areas enable row level security;

drop policy if exists "coach manages own stretch areas" on stretch_body_areas;
create policy "coach manages own stretch areas" on stretch_body_areas for all
  using (coach_id = (select auth.uid())) with check (coach_id = (select auth.uid()) and is_coach());

-- Seed: the old hardcoded starter suggestions, for every existing coach
insert into stretch_body_areas (coach_id, name)
select id, area from profiles
cross join (values ('Hips'),('Hamstrings'),('Quads'),('Calves'),('Inner Thighs'),('Glutes'),('Lower Back'),('Upper Back'),('Shoulders'),('Neck'),('Chest'),('Full Body')) as starters(area)
where role = 'coach'
on conflict (coach_id, name) do nothing;

-- Seed: any custom area already tagged on an existing stretch, so nothing
-- already in use silently disappears from Manage Areas
insert into stretch_body_areas (coach_id, name)
select distinct coach_id, unnest(body_areas) from stretches
on conflict (coach_id, name) do nothing;

-- ==========================================================================
-- Per-athlete home-screen toggles: mobility_enabled and tournaments_enabled,
-- alongside the existing can_self_log_workouts - all three now live in the
-- athlete's Settings tab (Calendar itself always stays on, no toggle). No
-- RLS change needed - not column-scoped.
--
-- mobility_enabled here is checked ALONGSIDE profiles.mobility_enabled
-- (settings.html's coach-wide "Mobility / Stretching" row), not instead of
-- it - that one stays as a global "I haven't filmed any stretches yet, hide
-- this from everyone" switch, this one lets the coach also turn it off for
-- one specific athlete once the feature IS ready overall.
--
-- can_self_log_workouts previously defaulted to false (an athlete had to be
-- explicitly opted in) - flipped to default true here, matching "own
-- workout" being one of the three things asked to be auto-on, and backfilled
-- for every existing athlete so this actually takes effect immediately
-- rather than only for athletes created from now on.
-- ==========================================================================
alter table athletes add column if not exists mobility_enabled boolean not null default true;
alter table athletes add column if not exists tournaments_enabled boolean not null default true;

alter table athletes alter column can_self_log_workouts set default true;
update athletes set can_self_log_workouts = true where can_self_log_workouts = false;

-- ==========================================================================
-- Let the coach manage logged mobility sessions from the calendar, same as
-- a real workout (minus copying - there's nothing to schedule ahead for a
-- logged session). mobility_focus_areas records the up-to-2 areas the
-- athlete picked in renderMobilityAreaPicker (athlete-app/dashboard.js), so
-- the coach can see what they were focusing on from the day-detail view.
-- No RLS change needed for the new column (not column-scoped), but there
-- was never a coach DELETE policy on workout_sessions at all before now -
-- coach could only view sessions and update the RPE-flag review columns.
-- ==========================================================================
alter table workout_sessions add column if not exists mobility_focus_areas text[];

drop policy if exists "coach deletes sessions for own athletes" on workout_sessions;
create policy "coach deletes sessions for own athletes" on workout_sessions for delete
  using (exists (select 1 from athletes a where a.id = workout_sessions.athlete_id and a.coach_id = (select auth.uid())));

-- ==========================================================================
-- Workout type: Gym / Field / Run. Previously every workout looked
-- identical wherever it showed up - trainings.workout_type is set at the
-- top of every reusable Workout Library entry and copied onto each
-- program_days row it's scheduled into (Program Builder day, "+ Add
-- Workout" on the athlete calendar, or a copied/cloned day) - from there
-- it's just a normal column on that specific day, adjustable on its own
-- from wherever that day is opened (Program Builder's day modal, the
-- coach's per-athlete calendar day-detail). Self-logged Own Workouts set it
-- directly: Strength -> gym, Field/Training -> field, the new Run choice ->
-- run. No RLS change needed for either column - not column-scoped, existing
-- "coach manages own X"/"athlete views own X" policies already cover it.
-- ==========================================================================
alter table trainings add column if not exists workout_type text not null default 'gym'
  check (workout_type in ('gym', 'field', 'run'));

alter table program_days add column if not exists workout_type text
  check (workout_type in ('gym', 'field', 'run'));

-- ==========================================================================
-- Low on (or out of) trainings: flags an active athlete on the Athletes
-- list (script.js) once their furthest scheduled day is within
-- low_trainings_warning_days of today (or they have none at all), sorts
-- them to the top, and fires a coach notification (the bell) the first
-- time each occurrence happens - low_trainings_notified_for stores which
-- "furthest date" state (or the literal 'never') was already notified
-- about, so reloading the list repeatedly doesn't spam a fresh
-- notification every time - only fixing it and later running dry again
-- does, since that's a different value to compare against.
-- ==========================================================================
alter table profiles add column if not exists low_trainings_warning_days int not null default 7;

alter table athletes add column if not exists low_trainings_notified_for text;

alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('workout_added', 'workout_completed', 'tournament_added', 'low_trainings'));

-- Every other notification type is athlete-triggered (see
-- athlete_notifies_own_coach above) - this one is computed by the coach's
-- own client while browsing the Athletes list, so it needs its own insert
-- policy.
drop policy if exists "coach creates own notifications" on notifications;
create policy "coach creates own notifications" on notifications for insert
  with check (coach_id = (select auth.uid()));

-- ==========================================================================
-- FORMS - reusable questionnaire templates (forms + form_questions), built
-- once in the Form Builder and assigned onto a specific athlete's specific
-- calendar day (form_assignments) from the same "+" popup used for a
-- Single Workout/Program/Section. Answers live in form_answers, one row
-- per question; form_assignments.completed_at is set once every question
-- has been answered and the athlete taps Submit.
--
-- gate_workout on the form itself (not the assignment) - a coach builds a
-- "daily readiness check" form ONCE with the gate on, then assigns it to
-- whichever days need it; the gate always behaves the same way wherever
-- that form gets used, so it belongs on the template, not repeated per
-- assignment. When on, the athlete app hides that day's Start/Continue
-- Workout button behind "Complete today's form first" until
-- form_assignments.completed_at is set for that day.
-- ==========================================================================
create table if not exists forms (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id),
  name text not null,
  gate_workout boolean not null default false,
  created_at timestamptz not null default now()
);
alter table forms enable row level security;
drop policy if exists "coach manages own forms" on forms;
create policy "coach manages own forms" on forms for all
  using (coach_id = (select auth.uid())) with check (coach_id = (select auth.uid()));

create table if not exists form_questions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references forms(id) on delete cascade,
  order_index int not null default 0,
  question_text text not null,
  type text not null check (type in ('short_text', 'long_text', 'scale_1_5')),
  created_at timestamptz not null default now()
);
alter table form_questions enable row level security;
drop policy if exists "coach manages own form questions" on form_questions;
create policy "coach manages own form questions" on form_questions for all
  using (exists (select 1 from forms f where f.id = form_questions.form_id and f.coach_id = (select auth.uid())))
  with check (exists (select 1 from forms f where f.id = form_questions.form_id and f.coach_id = (select auth.uid())));

-- form_assignments has to exist before the athlete-view policy on
-- form_questions below can reference it - created here, ahead of
-- form_questions' second policy, instead of after it
create table if not exists form_assignments (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id),
  athlete_id bigint not null references athletes(id) on delete cascade,
  form_id uuid not null references forms(id) on delete cascade,
  date date not null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table form_assignments enable row level security;
drop policy if exists "coach manages own form assignments" on form_assignments;
create policy "coach manages own form assignments" on form_assignments for all
  using (coach_id = (select auth.uid())) with check (coach_id = (select auth.uid()));
drop policy if exists "athlete views own form assignments" on form_assignments;
create policy "athlete views own form assignments" on form_assignments for select
  using (exists (select 1 from athletes a where a.id = form_assignments.athlete_id and a.user_id = (select auth.uid())));
drop policy if exists "athlete completes own form assignments" on form_assignments;
create policy "athlete completes own form assignments" on form_assignments for update
  using (exists (select 1 from athletes a where a.id = form_assignments.athlete_id and a.user_id = (select auth.uid())))
  with check (exists (select 1 from athletes a where a.id = form_assignments.athlete_id and a.user_id = (select auth.uid())));

create index if not exists idx_form_assignments_athlete_date on form_assignments(athlete_id, date);

drop policy if exists "athlete views own assigned form questions" on form_questions;
create policy "athlete views own assigned form questions" on form_questions for select
  using (exists (
    select 1 from form_assignments fa join athletes a on a.id = fa.athlete_id
    where fa.form_id = form_questions.form_id and a.user_id = (select auth.uid())
  ));

create table if not exists form_answers (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references form_assignments(id) on delete cascade,
  question_id uuid not null references form_questions(id) on delete cascade,
  answer_text text,
  answer_scale int check (answer_scale between 1 and 5),
  created_at timestamptz not null default now(),
  unique (assignment_id, question_id)
);
alter table form_answers enable row level security;
drop policy if exists "coach views own athletes form answers" on form_answers;
create policy "coach views own athletes form answers" on form_answers for select
  using (exists (select 1 from form_assignments fa where fa.id = form_answers.assignment_id and fa.coach_id = (select auth.uid())));
drop policy if exists "athlete manages own form answers" on form_answers;
create policy "athlete manages own form answers" on form_answers for all
  using (exists (
    select 1 from form_assignments fa join athletes a on a.id = fa.athlete_id
    where fa.id = form_answers.assignment_id and a.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from form_assignments fa join athletes a on a.id = fa.athlete_id
    where fa.id = form_answers.assignment_id and a.user_id = (select auth.uid())
  ));
