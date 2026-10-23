# Deployment status — 23 October 2026

The requested destination is **Render Free**, with a new **Neon Free** PostgreSQL
project. The installed OpenGym APK should use its existing **Connect to my server**
flow. Exercise planning is deferred until the hosted connection is working.

## Implementation

Based on upstream OpenGym v1.4.2, source revision
`e9a303877d02e4237b183f96a9a6603990e8fafb`, on local branch
`codex/render-free-postgres`. The older `alexpcosta/opengym` fork did not include
current native pairing; its earlier deployment experiment is superseded.

- [Render Blueprint](../../render.yaml): Free compute only; no paid disk/database.
- [Deployment guide](README.md): Docker, private owner signup and native pairing.
- [PostgreSQL backend](../../api/storage/README.md): durable accounts, instance
  keys, plans/history/revisions and audit, with commit-before-response semantics.
- [Codex client](../../scripts/opengym-client.mjs): separate pairing, plan
  export/update, revision conflicts and preservation of newer training history.
  Native pairing grants full-profile access; the helper itself only changes plans.

Custom uploads, the embedded server AI Coach and server background reminder jobs
are unavailable in this initial free backend. Built-in exercise media is included;
the installed APK keeps its native reminders. No custom APK is required.

## Verified locally

- Final Linux API regression run: **651 passed, 0 failed, 11 skipped** (662 tests,
  including nested suites). Eight database tests are opt-in and ran separately.
- **8 real PostgreSQL integration tests passed**: native bearer pairing, bootstrap
  invitation, fresh-directory restart, multi-process conditional writes,
  commit-failure rollback, optional audit failure, corrupt-storage refusal, and
  connection outage/recovery including mobile CORS and storage health checks.
- **6 Codex-client tests passed**, plus its real-database integration: a plan update
  preserved a newer phone workout and weigh-in.
- Deployment image built successfully. nginx served the frontend and bundled
  exercise media; native-origin pairing, invite-only owner creation, protected
  data access, durable plan saving and stale-revision conflicts passed.
- Recreated the application container with no local state/account files: the same
  paired token, owner, consumed invitation, workout and plan survived in Postgres.
- The image's configured health check passed. Runtime npm install reported zero
  audit findings at build time. Syntax and whitespace checks passed.

The first broad Linux test attempt used a Windows-mounted source tree and hit
startup timeouts. Final results above use native Linux files with Linux checkout
line endings. No frontend source was changed; the image uses the digest-pinned
official v1.4.2 frontend and exercise media.

## Remaining external steps

**No hosted API URL exists yet. No Neon project or Render service has been
created. No paid resources were created.**

Brave is now connected. Created the user's public fork at
https://github.com/kebo08/openGym and pushed the tested
`codex/render-free-postgres` branch (implementation commit `e50b8305`). Render's
Blueprint form is prepared for that repository/branch with name `opengym-free`.
It successfully reads `render.yaml` and is waiting for `DATABASE_URL`.

Neon is open in the same Brave profile at its sign-in screen. The user has been
asked to finish sign-in/sign-up there, keeping the Free plan. Render and Neon tabs
are preserved for continuation; no password or database URL has been requested in
chat.

1. The user signs in to Neon, then the agent creates a Free project. Authentication and any terms
   requiring the account holder must be completed by the user. Keep its connection
   string in server secret settings, outside source and chat.
2. Create the prepared Free Render Blueprint with the Neon `DATABASE_URL`.
   Verify TLS, health and restart behavior
   on the actual services. Local checks do not prove cloud deployment.
3. The user creates the private owner profile with the bootstrap invitation, then
   pairs the existing APK using the hosted HTTPS origin and a five-minute code.
   Verify actual phone sync before considering the setup complete.
4. Pair a separate Codex client session when plan management is requested. Keep
   credentials in the ignored `.opengym/` directory and out of plan exports.
