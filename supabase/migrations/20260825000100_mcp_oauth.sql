-- Remote MCP connector: OAuth 2.1 so ChatGPT, Claude on the web and Claude on
-- a phone can connect. The app acts as its own tiny authorization server.
--
-- Design notes:
--  * Single user. Every grant belongs to the one owner; the authorize step
--    proves it by requiring a live Supabase session in the browser.
--  * Secrets are never stored in the clear. Authorization codes, access
--    tokens and refresh tokens are kept as sha256 hashes, exactly like a
--    password would be, so a database leak yields nothing usable.
--  * Public clients with PKCE only: no client secrets to leak. MCP clients
--    register themselves dynamically, which is how ChatGPT and Claude expect
--    to connect.

create type mcp_grant_kind as enum ('code', 'access', 'refresh');

create table mcp_clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id text not null unique,
  client_name text not null default 'MCP client',
  redirect_uris text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table mcp_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id text not null,
  kind mcp_grant_kind not null,
  -- sha256 hex of the secret handed to the client; the secret itself is never
  -- stored and cannot be recovered from here.
  token_hash text not null unique,
  -- PKCE, codes only
  code_challenge text,
  redirect_uri text,
  scope text not null default 'lifeos',
  expires_at timestamptz not null,
  -- codes are single use; the timestamp makes a replay visible rather than
  -- silently ignored
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index mcp_grants_kind_idx on mcp_grants (kind);
create index mcp_grants_expiry_idx on mcp_grants (expires_at);
create index mcp_clients_client_id_idx on mcp_clients (client_id);

-- Owner-only, so the Settings screen can list and revoke connections. Writes
-- during the OAuth dance happen through the service role, which scopes every
-- statement to the owner itself.
alter table mcp_clients enable row level security;
alter table mcp_grants enable row level security;

create policy owner_all on mcp_clients for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy owner_all on mcp_grants for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
