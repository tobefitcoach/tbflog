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
