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

## Live deployment

**API and app origin: https://opengym-elvn.onrender.com**

- Source: https://github.com/kebo08/openGym, branch
  `codex/render-free-postgres`; deployed commit `74a018a`.
- Render Blueprint `opengym-free`, service `opengym`, **Free** compute in Singapore.
  Deployment `dep-dbdn9q0473hc73cvk61g` succeeded in 1m22s on 23 October 2026.
- Neon organization `OpenGym Personal`, project/database `opengym`, **Free** plan,
  PostgreSQL 16 in AWS Singapore. The pooled connection is stored only in Render's
  secret environment setting. No paid resources were created.
- Public HTTPS verification passed: `/api/health` returned 200 with `ok: true`,
  `users: 0`, `writable: true`; `/api/config` confirmed invite-only registration;
  unauthenticated `/api/data` returned 401; the frontend and bundled exercise
  media returned 200. Render marked the deployment Live.
- Free instances sleep with inactivity; Render warns that wake-up requests can
  take 50 seconds or more. The database, rather than the temporary Render
  filesystem, stores profiles, credentials and exercise data.

## Remaining user steps

The live app's owner registration form is prepared in Brave with the private
bootstrap invite. The user must click **Create passkey** and complete device
authentication. No owner profile or paired client has been created yet.

1. Complete owner passkey creation. Then generate a five-minute mobile pairing
   code in Settings > Account > Pair the mobile app.
2. In the existing APK, use Settings > Account > Connect to my server. Enter the
   HTTPS origin above and the pairing code. Verify actual phone sync before
   considering the connection complete; the URL alone does not authenticate.
3. Pair a separate Codex client session when plan management is requested. Keep
   credentials in the ignored `.opengym/` directory and out of plan exports.
4. Confirm live account/session persistence after a controlled service restart.
   Fresh-filesystem persistence already passed locally, but has not yet been
   exercised with a real owner profile on the hosted service.
