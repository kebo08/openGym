# Optional PostgreSQL storage

Without `DATABASE_URL`, the API retains its existing file storage. With it, instance
accounts/passkeys/subscriptions/invites, signing/encryption secret, VAPID keys,
profile documents/revisions and audit events live directly in PostgreSQL. Local
files are not a backup gateway or an authoritative write buffer.

Required settings:

```text
DATABASE_URL=postgresql://...              # protected server setting
MEDIA_UPLOADS=0
COACH_DISABLED=1
```

`OPENGYM_DATABASE_SCHEMA` selects a schema (default `public`), useful for isolated
integration tests. Remote connections enforce `sslmode=verify-full`; loopback
Postgres may use plaintext for disposable development tests. Never disable server
certificate verification for a hosted database.

For private initial registration, use `INVITE_ONLY=1`, `FIRST_USER_ADMIN=1` and a
random `OPENGYM_BOOTSTRAP_INVITE` of at least 16 characters. The effective invite is
its **first 32 characters after trimming, uppercased**; that fits the stock mobile
and web input. Store/share it privately. It is inserted only when creating the
instance row, never reinserted on restart or after account deletion. There is no
secret-retrieval endpoint or log output. Subsequent invites use the normal admin UI.

Each request reads authoritative working objects inside a transaction and locks the
instance row and state rows. Existing synchronous domain helpers operate on those
transaction-local objects. Account/state writes and native sync stamps, revision
checks and write-ID ancestry commit before any successful JSON response leaves.
On failure, the working objects are discarded and the API returns 503. A failed or
unreadable database never causes an empty local replacement instance to be created.
Audit writes use savepoints and remain best-effort, matching file mode.

The initial backend targets a small personal instance: it serializes requests and
loads profile documents and retained audit rows inside the transaction. Bodies are
read and limited before acquiring the database lock. Large shared instances should
use a future storage design with selective reads and finer-grained locking.

Uploads and the built-in server Coach are explicitly unavailable in this mode.
Recurring server reminder/nudge jobs and server rest-timer pushes are also disabled:
a sleeping free host cannot deliver them reliably. Native reminders remain on the
phone. Profile sync, pairing, account administration, immediate push tests and
native nudge-check reads retain their API contracts. External Codex uses a separately
paired session through the normal API; no provider login cache is stored here.

Back up the database, including the instance row holding keys. This backend does
not automatically migrate an existing file instance. Import training data through
the app after creating/pairing a profile; preserve the old files until verified.
Keep a stock-app JSON export as an independent backup. Free database quotas and
cold-start delays remain hosting constraints, not persistence guarantees.

Real integration tests use a disposable database and isolated schemas:

```sh
TEST_DATABASE_URL=postgresql://... node --test test/server-postgres.test.js
```

Tests cover the stock native pairing/bearer contract, restart with an empty local
directory, concurrent revision checks across processes, commit failure, actual
transport failure/recovery and refusal to start against unavailable storage.
