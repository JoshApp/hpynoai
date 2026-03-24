-- Initial schema for HypnoAI user data
-- Tables: profiles, user_settings, session_history, subscriptions, purchases, favorites
-- All tables have RLS enabled with user-scoped policies

-- ============================================================
-- 1. profiles — extends auth.users
-- ============================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  experience_level text default 'listen' check (experience_level in ('listen', 'watch', 'breathe', 'immerse')),
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- ============================================================
-- 2. user_settings — JSONB settings blob per user
-- ============================================================
create table public.user_settings (
  id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb default '{}'::jsonb not null,
  updated_at timestamptz default now() not null
);

alter table public.user_settings enable row level security;

create policy "Users can view own settings"
  on public.user_settings for select
  using (auth.uid() = id);

create policy "Users can upsert own settings"
  on public.user_settings for insert
  with check (auth.uid() = id);

create policy "Users can update own settings"
  on public.user_settings for update
  using (auth.uid() = id);

-- ============================================================
-- 3. session_history — tracks session starts/completions
-- ============================================================
create table public.session_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_type text not null,
  started_at timestamptz default now() not null,
  completed_at timestamptz,
  duration_seconds integer,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now() not null
);

create index idx_session_history_user on public.session_history(user_id, started_at desc);

alter table public.session_history enable row level security;

create policy "Users can view own history"
  on public.session_history for select
  using (auth.uid() = user_id);

create policy "Users can insert own history"
  on public.session_history for insert
  with check (auth.uid() = user_id);

create policy "Users can update own history"
  on public.session_history for update
  using (auth.uid() = user_id);

-- ============================================================
-- 4. subscriptions — Stripe subscription state (webhook-written)
-- ============================================================
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_subscription_id text unique,
  plan text not null check (plan in ('premium_monthly', 'premium_annual', 'pro_monthly', 'pro_annual')),
  status text not null default 'active' check (status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean default false,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create unique index idx_subscriptions_user on public.subscriptions(user_id) where status in ('active', 'trialing', 'past_due');
create index idx_subscriptions_stripe_customer on public.subscriptions(stripe_customer_id);

alter table public.subscriptions enable row level security;

-- Users can read their own subscriptions but cannot modify them (webhooks use service_role)
create policy "Users can view own subscriptions"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- ============================================================
-- 5. purchases — one-time Stripe purchases (webhook-written)
-- ============================================================
create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_payment_intent_id text unique not null,
  product_type text not null check (product_type in ('lifetime', 'session_unlock')),
  product_metadata jsonb default '{}'::jsonb,
  amount_cents integer not null,
  currency text not null default 'eur',
  created_at timestamptz default now() not null
);

create index idx_purchases_user on public.purchases(user_id);

alter table public.purchases enable row level security;

-- Users can read their own purchases but cannot modify them (webhooks use service_role)
create policy "Users can view own purchases"
  on public.purchases for select
  using (auth.uid() = user_id);

-- ============================================================
-- 6. favorites — saved session bookmarks
-- ============================================================
create table public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_type text not null,
  created_at timestamptz default now() not null,
  unique(user_id, session_type)
);

create index idx_favorites_user on public.favorites(user_id);

alter table public.favorites enable row level security;

create policy "Users can view own favorites"
  on public.favorites for select
  using (auth.uid() = user_id);

create policy "Users can insert own favorites"
  on public.favorites for insert
  with check (auth.uid() = user_id);

create policy "Users can delete own favorites"
  on public.favorites for delete
  using (auth.uid() = user_id);

-- ============================================================
-- 7. Stripe webhook idempotency tracking
-- ============================================================
create table public.stripe_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz default now() not null
);

alter table public.stripe_events enable row level security;
-- No user-facing policies — only service_role writes/reads this table

-- ============================================================
-- 8. Auto-create profile on signup
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    new.raw_user_meta_data ->> 'name',
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- 9. updated_at auto-update trigger
-- ============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger user_settings_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

create trigger subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();
