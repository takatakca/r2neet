# Automation health, alerting and off-host backups

## Never-succeeded is not the same as overdue

They both block a clean launch, but they send an operator to different
places:

| Status | Meaning | Where to look |
|---|---|---|
| `NEVER_SUCCEEDED` | Never proven **in this environment** | Is the process started? Is a credential missing? |
| `OVERDUE` | Worked before, has now stopped | Something broke since it last ran |
| `FAILING` | Worked before, now erroring | Read `lastError` |
| `NOT_CONFIGURED` | A required credential is absent | Expected; suppresses false alarms |
| `HEALTHY` | Succeeded inside its window | — |

Collapsing the first two into one status sends people hunting for a
regression when the real answer is "the container never started."

`/admin#operations` shows them as separate counts.

## Cutover is gated on evidence

A critical worker is `READY` only once it has **actually succeeded here**.
Source code existing is not evidence, and neither is a passing test suite on a
laptop. The Setmore cutover page reports `BLOCKED` until each one has a
successful `WorkerRun` row.

Verified:

```
CUTOVER_BLOCKED_BY: callbacks,notifications-retry,recurrence,backup
```

## Startup grace suppresses the page, never the truth

A worker that has never succeeded is visible immediately and blocks cutover
immediately. It only stops *paging* someone for
`WORKER_STARTUP_GRACE_MINUTES` (default 15) after boot, so a deploy does not
wake anyone. Asserted by test: status and blockers are present during grace;
only `alertable()` is empty.

## Alerts are deduplicated

A worker down for 45 minutes with a one-minute health check must produce one
alert, not 45. Deduplication is a unique `key` on `OperationalAlert`; repeat
observations increment a counter on the open incident.

Verified: 20 health checks across 4 simultaneous problems produced **4**
webhook deliveries, one per distinct problem.

Resolution closes the incident, so the next occurrence is news again.

**An alert survives a failed send.** If the webhook is down the row stays
`OPEN` with `deliveryStatus: FAILED` and remains visible in admin. We never
raise an alert about failing to send an alert — that is how paging storms
start.

With no destination configured the alert is still recorded and shown, marked
`NOT_CONFIGURED`. It is never reported as delivered.

## Alert destination

Vendor-neutral: anything that accepts an HTTP POST.

```
ALERT_WEBHOOK_URL=https://...
ALERT_WEBHOOK_SECRET=...        # optional HMAC-SHA256 signature
```

Payloads carry a key, severity, category, title, message, environment and a
resource name. A test asserts they contain **no email addresses and no phone
numbers** — an alert routed to a chat channel must not leak customer data.

## Off-host backups

Any S3-compatible provider: AWS, Cloudflare R2, Backblaze B2, DigitalOcean
Spaces, MinIO. Only the endpoint changes.

```
BACKUP_S3_BUCKET=
BACKUP_S3_ACCESS_KEY_ID=
BACKUP_S3_SECRET_ACCESS_KEY=
BACKUP_S3_ENDPOINT=              # non-AWS providers
BACKUP_S3_FORCE_PATH_STYLE=true  # MinIO and some others
```

SigV4 signing is implemented directly rather than pulling in the AWS SDK,
which is a very large dependency for two operations. All cryptography is
Node's `crypto`; this is the signing protocol, not a cipher. A test asserts
the secret key never appears in a signed request.

Objects are keyed `prefix/environment/database/YYYY/MM/DD/file.dump`, so
lifecycle rules and manual inspection are straightforward and staging can
never overwrite production.

### Upload is verified, not assumed

**A 200 from PUT or a matching HEAD size is not proof of data integrity.**
The updated backup flow issues HEAD for presence and size, then streams a signed
GET and hashes the **actual remote bytes** with SHA-256, comparing it with the
original local dump. Equal-size corruption, a truncated GET and a failed
verification download cause a failed backup and the local copy is preserved.
The GET is streamed rather than buffered in full. This code change still needs
its PR CI and rollout, and it does not prove a real S3 provider or restore drill.

Proven against a deliberately lying endpoint that accepts every PUT and stores
nothing:

```
OFFHOST_VERIFIED: true | bytes: 4096
SILENT_UPLOAD_FAILURE_CAUGHT: VERIFY_MISSING
```

A failed upload raises a `CRITICAL` alert and fails the run, so a
local-only dump is never recorded as a completed backup.

Each run records the encryption key id the dump requires — a restore can
confirm it holds matching key material before trusting the file.

## Memory-safe S3 backup uploads (new code, release pending)

Branch `chatgpt/s3-stream-upload-20261016` computes SHA-256 by sequentially streaming a PostgreSQL dump, then streams the signed PUT from disk without loading the dump into process heap. Objects over the 5 GiB single-PUT limit fail closed with an actionable error; multipart upload is not yet implemented. Remote HEAD and signed GET verification remains required. The PR and exact-SHA production rollout have not been confirmed, and actual S3 provider credentials plus scratch restore are still outstanding.

## Still needs a decision from the owner

- Which S3-compatible provider, and its credentials
- Where alerts should land (chat webhook, monitoring service, relay)
- Off-host retention policy on the bucket
