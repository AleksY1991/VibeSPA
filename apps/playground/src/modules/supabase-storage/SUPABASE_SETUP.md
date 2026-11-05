# Supabase setup for `?backend=supabase`

**Apply this yourself, in your own Supabase project.** The playground, its tests
and coding agents never execute this SQL or change project settings. Tests mock
`rxdb/plugins/replication-supabase`.

## 1. Environment

Create `apps/playground/.env.local` (ignored by git):

```sh
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<the project's anon public key>
```

Restart `pnpm dev` after changing it. Only the public anon key belongs here;
row-level security below is what limits each account to its own rows.

## 2. Auth settings (dashboard → Authentication)

- Enable the **Email** provider (magic links).
- **Site URL:** `http://127.0.0.1:8081`
- **Redirect URLs:** add `http://127.0.0.1:8081/?backend=supabase`
- The built-in email service is rate-limited; configure SMTP for real use.
- The playground uses the PKCE flow: open the link in the same browser that
  requested it.

## 3. Table, row-level security and Realtime

The local RxDB collection holds exactly `id`, `title` and `done`. Replication
adds `_deleted` (soft delete) and reads `_modified` for its checkpoints;
`owner_id` stays on the server and is stripped from pulled rows. `id` is `text`
because the playground's ids are `<timestamp>-<uuid>`.

```sql
create table if not exists public.intentions (
  id text primary key check (char_length(id) between 1 and 100),
  title text not null check (char_length(btrim(title)) between 1 and 140),
  done boolean not null default false,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  _deleted boolean not null default false,
  _modified timestamptz not null default now()
);

create index if not exists intentions_modified_id on public.intentions (_modified, id);
create index if not exists intentions_owner on public.intentions (owner_id);

-- Every write gets a fresh _modified; an update can never move a row to another owner.
create or replace function public.intentions_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new._modified := clock_timestamp();
  if tg_op = 'UPDATE' then new.owner_id := old.owner_id; end if;
  return new;
end $$;

create trigger intentions_touch before insert or update on public.intentions
  for each row execute function public.intentions_touch();

alter table public.intentions enable row level security;
grant select, insert, update on public.intentions to authenticated;

create policy intentions_select_own on public.intentions for select to authenticated
  using (owner_id = (select auth.uid()));
create policy intentions_insert_own on public.intentions for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy intentions_update_own on public.intentions for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
-- No delete policy: deletion is the _deleted soft delete.

alter publication supabase_realtime add table public.intentions;
```

## 4. What to expect

- Signed out, the page shows a sign-in form. The link signs you in and opens a
  per-account local database, `vibespa-focus-supabase-<user id>`.
- Edits apply locally at once and sync in the background; the footer shows the
  sync status. Other tabs and devices receive changes through Realtime.
- When a newer saved row replaces one of your changes, a notice reports it.
  Undo for that change is refused.
- Signing out stops replication. Local data for the account stays in this
  browser.
- The server checks title length in characters; the playground's title policy
  counts UTF-16 units, so an emoji-heavy title written elsewhere can be refused
  locally and is reported in the console.
