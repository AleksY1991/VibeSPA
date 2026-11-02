<!-- sql-approval-and-supabase-ban:begin -->
# Explicit user policy: SQL approval and Supabase ban

Effective 2026-10-26. This is an explicit user override and takes precedence over conflicting repository or skill guidance, including instructions naming another file as the only agent guide. It applies to the main agent and every delegated agent.

- NEVER execute any SQL without the user's prior, explicit approval of the exact SQL and its target database/environment. This includes read-only SELECT/EXPLAIN, local or remote SQL, migrations, DDL/DML, database RPC/admin calls, ORM or seed scripts, and tests or application commands that execute SQL.
- Preparing or reviewing SQL as text is allowed. Present the concrete SQL and target for approval before executing it. General instructions to fix, implement, test, deploy, or do everything are not SQL approval. Available credentials, a logged-in dashboard, previous approvals for different SQL, and tool permissions are not approval.
- Do not auto-apply migrations, silently retry SQL, or switch to a browser, CLI, HTTP/admin API, MCP, ORM, test runner, or other route to bypass this requirement. If a command may execute SQL, stop and request approval before running it.
- Supabase agent skills and integrations are banned. Do not invoke, install, suggest, connect, reconnect, or re-enable Supabase skills, plugins, connectors, or MCP servers. Do not use browser/CLI/HTTP fallbacks to access Supabase on the agent's behalf.
- The Supabase ban remains in force until the user explicitly revokes it. SQL approval alone does not re-enable an integration; permission to use an integration alone does not approve SQL.
- Preserve existing application runtime Supabase code and configuration unless the user separately requests an application change. This policy disables agent access; it does not authorize breaking the application.

<!-- sql-approval-and-supabase-ban:end -->

# VibeSPA agent instructions

Read `CLAUDE.md`. It is the single architecture and contributor guide.
