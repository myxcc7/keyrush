-- 键速对决 · Supabase 初始化/升级脚本（全量，可重复执行）
-- 用法：Supabase 控制台 → SQL Editor → 粘贴整段执行一次。
-- 注意：本脚本会清空历史对局、排行榜与已注册用户（按要求重置）。

create extension if not exists pgcrypto;

/* ---------- 用户账号（自建：昵称 + 密码，最低 6 位，无强度要求） ---------- */

create table if not exists public.users (
  nickname text primary key,
  password_hash text not null,
  created_at timestamptz not null default now()
);

alter table public.users enable row level security;
-- 不开放对 users 表的直读直写，仅通过下方安全函数访问

-- 一键登录/注册：账户不存在则直接注册；存在则校验密码
create or replace function public.login_or_register(p_nickname text, p_password text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_nickname, ''));
begin
  if char_length(v_name) < 1 or char_length(v_name) > 12 then
    return '昵称需 1-12 个字符';
  end if;
  if char_length(coalesce(p_password, '')) < 6 then
    return '密码至少 6 位';
  end if;
  if exists (select 1 from public.users where nickname = v_name) then
    if exists (
      select 1 from public.users
      where nickname = v_name
        and password_hash = extensions.crypt(p_password, password_hash)
    ) then
      return 'ok';
    end if;
    return '密码错误';
  end if;
  insert into public.users (nickname, password_hash)
  values (v_name, extensions.crypt(p_password, extensions.gen_salt('bf')));
  return 'ok';
end $$;

grant execute on function public.login_or_register(text, text) to anon, authenticated;

-- 清理旧版分离式注册/登录函数
drop function if exists public.try_register(text, text);
drop function if exists public.try_login(text, text);

/* ---------- 对局记录 ---------- */

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  room_code text not null,
  difficulty text not null,
  text_id text,
  winner_name text,
  started_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.match_players (
  id bigserial primary key,
  match_id uuid not null references public.matches(id) on delete cascade,
  player_id text,
  nickname text not null,
  elapsed_ms integer,
  chars integer,
  correct_chars integer,
  accuracy numeric(5, 2),
  kpm numeric(6, 1),
  finished boolean not null default false,
  is_winner boolean not null default false,
  outcome text, -- 'win' | 'lose' | 'draw'
  created_at timestamptz not null default now()
);

alter table public.match_players add column if not exists outcome text;

create index if not exists match_players_nickname_idx on public.match_players (nickname);
create index if not exists match_players_match_id_idx on public.match_players (match_id);

alter table public.matches enable row level security;
alter table public.match_players enable row level security;

drop policy if exists "matches read" on public.matches;
create policy "matches read" on public.matches
  for select to anon, authenticated using (true);

drop policy if exists "matches insert" on public.matches;
create policy "matches insert" on public.matches
  for insert to anon, authenticated with check (true);

drop policy if exists "match_players read" on public.match_players;
create policy "match_players read" on public.match_players
  for select to anon, authenticated using (true);

drop policy if exists "match_players insert" on public.match_players;
create policy "match_players insert" on public.match_players
  for insert to anon, authenticated with check (true);

/* ---------- 公开房间列表 ---------- */

-- 房主建房时登记；每 8 秒心跳刷新 updated_at；开局或离开时删除。
-- 列表只展示 updated_at 在 15 秒内的 waiting 房间，房主断线后房间自动消失。
create table if not exists public.rooms (
  code text primary key,
  host text not null,
  difficulty text not null default 'easy',
  status text not null default 'waiting',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.rooms enable row level security;

drop policy if exists "rooms read" on public.rooms;
drop policy if exists "rooms write" on public.rooms;
drop policy if exists "rooms update" on public.rooms;
drop policy if exists "rooms delete" on public.rooms;
create policy "rooms read" on public.rooms
  for select to anon, authenticated using (true);
create policy "rooms write" on public.rooms
  for insert to anon, authenticated with check (true);
create policy "rooms update" on public.rooms
  for update to anon, authenticated using (true);
create policy "rooms delete" on public.rooms
  for delete to anon, authenticated using (true);

grant select, insert, update, delete on public.rooms to anon, authenticated;

-- 清理历史残留房间
delete from public.rooms where true;

/* ---------- 排行榜 ---------- */
-- 说明：本脚本可重复执行；为保留历史战绩，这里不再清空数据。
-- 如需重置战绩，可单独执行：truncate table public.match_players, public.matches;
-- 如需重置用户，可单独执行：truncate table public.users;

-- 胜局榜：胜/平/负战绩 + 速度
drop view if exists public.leaderboard;
create or replace view public.leaderboard_wins
with (security_invoker = true) as
select
  nickname,
  count(*)::int as races,
  count(*) filter (where outcome = 'win')::int as wins,
  count(*) filter (where outcome = 'draw')::int as draws,
  count(*) filter (where outcome = 'lose')::int as losses,
  round(max(kpm), 1) as best_kpm,
  round(avg(kpm), 1) as avg_kpm,
  round(avg(accuracy), 1) as avg_accuracy,
  max(created_at) as last_played
from public.match_players
where kpm is not null
group by nickname
order by wins desc, avg_kpm desc
limit 100;

-- 平均耗时榜（每日快照）：每日凌晨（北京时间 0:00，即 UTC 16:00）
-- 由 pg_cron 定时任务统一计算一次，白天只读快照
create table if not exists public.leaderboard_avg_daily (
  nickname text primary key,
  avg_ms integer not null,
  races integer not null,
  snapshot_date date not null,
  computed_at timestamptz not null default now()
);

alter table public.leaderboard_avg_daily enable row level security;

drop policy if exists "avg daily read" on public.leaderboard_avg_daily;
create policy "avg daily read" on public.leaderboard_avg_daily
  for select to anon, authenticated using (true);

grant select on public.leaderboard_avg_daily to anon, authenticated;

create or replace function public.refresh_avg_leaderboard()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  truncate table public.leaderboard_avg_daily;
  insert into public.leaderboard_avg_daily (nickname, avg_ms, races, snapshot_date, computed_at)
  select
    nickname,
    round(avg(elapsed_ms))::int as avg_ms,
    count(*)::int as races,
    current_date,
    now()
  from public.match_players
  where finished
  group by nickname
  order by avg(elapsed_ms) asc
  limit 100;
end $$;

-- 定时任务：清理旧计划后按 UTC 16:00（北京时间凌晨 0:00）重建
do $$
begin
  create extension if not exists pg_cron;
exception
  when others then null;
end $$;

do $$
begin
  perform cron.unschedule('refresh-avg-leaderboard');
exception
  when others then null;
end $$;

do $$
begin
  perform cron.schedule('refresh-avg-leaderboard', '0 16 * * *',
    'select public.refresh_avg_leaderboard()');
exception
  when others then null;
end $$;

-- 部署后立即生成首份快照
select public.refresh_avg_leaderboard();
