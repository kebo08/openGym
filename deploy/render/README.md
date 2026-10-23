# Free Render deployment

This adapter runs one **Free** Render web service, with a separately provisioned
durable PostgreSQL database. It creates no paid Render resources and no Render
database. Supply the database URL through the secret `DATABASE_URL` environment
variable. Startup refuses to run without that URL rather than starting with
ephemeral accounts or workout history.

The optional PostgreSQL persistence implementation in this checkout must be present;
an unmodified upstream API does not become database-backed by setting a variable.
Use a durable external provider's free tier, not Render Free Postgres, which expires
after 30 days. Check the external provider's quotas and inactivity policy before use.

## What runs

- The exact official openGym v1.4.2 browser app, including its complete bundled
  exercise media, copied from a verified, digest-pinned multi-architecture image.
  No media is hotlinked and no old exercise-dataset URLs are substituted.
- This checkout's API with PostgreSQL-backed accounts, passkeys, profile state,
  session signing secret and activity log. This is a specific database backend,
  not a general sync of the container's filesystem.
- nginx on `PORT` (10000 by default), forwarding API calls to internal port 3000.
  The upstream nginx template preserves raw request paths, mobile CORS responses,
  browser security headers, caching and exercise-media origin restrictions.
- `COACH_DISABLED=1`: no embedded AI provider or refreshable account credentials.
  Codex can manage plans separately through an explicitly paired API connection.
- `MEDIA_UPLOADS=0`: custom photo/video uploads stay disabled in this initial setup.
  Built-in exercise stills and animations are included and remain available.
- Server-side reminder timers and background Coach jobs are unavailable in this
  PostgreSQL mode. Use the APK's native reminders. Pairing codes and sign-in
  challenges are deliberately short-lived and may expire when the service sleeps.

Render's own `RENDER_EXTERNAL_URL` or `RENDER_EXTERNAL_HOSTNAME` determines the app
origin and passkey RP hostname. For a custom domain, set matching `ORIGIN` and
`RP_ID` before creating a passkey. Changing the hostname later invalidates old
passkeys. The adapter serves the root path, not a subpath.

Signup requires an invite (`INVITE_ONLY=1`). The Blueprint privately generates
`OPENGYM_BOOTSTRAP_INVITE`; a brand-new PostgreSQL instance seeds exactly one invite
using the **first 32 characters** of its trimmed value, converted to uppercase.
Invite entry is case-insensitive. A manually supplied value must have at least 16
characters. `FIRST_USER_ADMIN=1` makes the profile created with that invite the
owner/admin. A visitor without the invite cannot claim ownership merely by arriving
first. Treat the generated value as a secret and do not put it in logs or messages.

The bootstrap invite is consumed once. Restarting, redeploying or changing the
environment variable does not seed another invite into an existing database. Later
invites come from the owner's admin dashboard. Keep invite-only signup enabled.

## Render setup

Connect your copy of this repository in Render and use its `render.yaml` Blueprint,
or create a Docker Web Service with `deploy/render/Dockerfile`, repository-root build
context, Free compute and health path `/api/health`. Enter `DATABASE_URL` as a secret;
never commit it or paste it into documentation. For manual service creation also set
`INVITE_ONLY=1`, `FIRST_USER_ADMIN=1` and a strong random
`OPENGYM_BOOTSTRAP_INVITE` before its first start. The Blueprint generates that
secret for you. It deliberately contains no disk, paid compute plan, or database
resource.

Free Render services sleep after 15 minutes without traffic. Waking may take about
a minute. The PostgreSQL backend must retain accounts and plans independently of
the web service, and failed database access must prevent successful state writes.

Once the instance is healthy, open the service's Environment settings in Render and
privately copy the **first 32 characters** of the generated
`OPENGYM_BOOTSTRAP_INVITE` value. Open the instance in a browser, enter those 32
characters as the signup invitation (case does not matter), and create your owner profile.
Use its **Pair the mobile app** setting to generate a short-lived pairing code, then
enter the server's HTTPS URL and that pairing code in the installed APK's **Connect
to my server** flow. The bootstrap signup invitation and phone pairing code serve
different steps. Use the same profile for plan changes and phone sync.

## Connect Codex separately

No OpenAI API key or ChatGPT/Codex login is needed on Render. Codex runs on your
computer and uses `scripts/opengym-client.mjs` to work with your hosted profile.
After pairing the phone, generate a **new** short-lived pairing code from the same
profile for this local helper; each code can be redeemed once.

```sh
node scripts/opengym-client.mjs pair --server https://YOUR-SERVER.onrender.com --auth .opengym/codex-session.json
```

The helper reads the pairing code from standard input, not a command-line argument.
Enter it privately and finish standard input using the terminal's EOF shortcut.
The resulting credential is saved locally and is not printed. Keep `.opengym/`
private; it is excluded from Git and Docker build contexts in this checkout.

This is a separate **full-profile bearer credential**, with the same account access
as a paired device. It is not a server-enforced read-only or plan-only token. The
helper limits its own writes to plan fields and starts with the latest profile
document so recorded workouts and weigh-ins are preserved. Its plan export contains
server/profile metadata, not the credential.

```sh
node scripts/opengym-client.mjs status --auth .opengym/codex-session.json
node scripts/opengym-client.mjs export-plan --auth .opengym/codex-session.json --file plan.json
# Review/edit the exported plan, retaining its codex_source metadata.
node scripts/opengym-client.mjs apply-plan --auth .opengym/codex-session.json --file plan.json
```

An apply refuses a plan from a different profile or server, changed plan data, or a
concurrent write. Export again and review before retrying. Once accepted by the API,
the same profile's mobile sync can receive the updated plan.

## Disposable local verification

Use test credentials and data only. These commands create a disposable PostgreSQL
container and share its network namespace with the app, so its database connection
uses loopback. This backend requires verified TLS for non-loopback databases; do
not disable that verification to connect to a cloud database. The commands do not
provision any cloud resource. Replace `docker` with `podman` for that runtime.

```sh
docker run -d --name opengym-verify-db -p 10000:10000 \
  -e POSTGRES_USER=opengym -e POSTGRES_PASSWORD=local-test-only \
  -e POSTGRES_DB=opengym postgres:17-alpine
docker build -f deploy/render/Dockerfile -t opengym-render .
docker run --rm --name opengym-verify-app --network container:opengym-verify-db \
  -e DATABASE_URL=postgresql://opengym:local-test-only@127.0.0.1:5432/opengym \
  -e ORIGIN=http://localhost:10000 -e FIRST_USER_ADMIN=1 -e INVITE_ONLY=1 \
  -e OPENGYM_BOOTSTRAP_INVITE=0123456789ABCDEF0123456789ABCDEF opengym-render
```

Wait for PostgreSQL readiness before starting the app. Check `/api/health`, the web
UI and a bundled media file such as `/exercise-media/still/0001.webp`. Confirm signup
without an invite is refused. Register a test profile with the disposable bootstrap
invite above, pair an API client, save a test plan, then recreate the app container
against the same database and confirm the profile, token and plan still work. Check
that restarting does not recreate the consumed bootstrap invitation. Test a database
outage and confirm failed writes are not acknowledged as saved.

After verification, stop the app and remove only the disposable database container:

```sh
docker rm -f opengym-verify-db
```

The pinned web image is
`ghcr.io/duartesantos8/opengym-web:1.4.2@sha256:748c77417d40969d9840f064fd0cafecd84e47ac786d424688d0cff0d6b53299`.
It preserves the upstream licensed-media notices. Updates should deliberately pair
a compatible upstream frontend release with the API, rather than tracking `latest`.

References: [Render Free limits](https://render.com/docs/free),
[OpenGym mobile connection guide](https://opengym.ch/docs.html#connecting-the-mobile-app-to-your-server),
[upstream self-hosting](../../docs/SELF_HOSTING.md).
