alter table public.user_settings
add column if not exists display_name text,
add column if not exists avatar_url text,
add column if not exists avatar_color text default 'mint';
