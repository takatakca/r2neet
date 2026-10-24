# Private customer and contact directory

`/admin#customers` is an OWNER-only directory. It has two views:

- **Contacts courriel**: historical correspondence, editable names and classification
  (`TO_REVIEW`, `PROSPECT`, `CUSTOMER`, `OTHER`), search, 50-row pagination and
  dated Gmail source links. Sources are limited to 100 per detail response and
  the interface discloses when more exist.
- **Comptes du site**: existing `Customer` records, account completion and booking
  counts. Historical contact evidence is not used as login authority.

The `customers.manage` permission is OWNER-only and is enforced by the API,
including search, details, import and edits. All responses are private/no-store.
There is no public contact lookup, source-body endpoint or marketing-list export.

## Database and identity

Migration `20261024090000_add_customer_contacts` adds `CustomerContact`, its status
enum and `CustomerContactSource`. It does not alter existing login, reservation,
payment or marketing-consent data. Unique normalized email and a per-contact
account/message constraint make retries idempotent. Advisory transaction locks
in sorted email order serialize overlapping imports and preserve historical
bounds. Editing classification never grants login or email-marketing consent.

These tables hold unverified CRM evidence, not a replacement identity system.
Matching an account and an imported address is not enough to merge or verify
them. Other sources (Wave/Setmore) need their own verified mapping later.

## Import the existing private Gmail inventory

Keep actual JSON/CSV files outside this public repository and all build contexts.
Use the `inventory.json` produced by `scripts/extract-gmail-contacts.py`. It must
identify `source_account` as `r2nette.ca@gmail.com` and contain contacts with `contact_id`, `email`, optional `display_name`, and source
tuples `[contact_id, message_id, timestamp, direction, source_url]`.
The projection drops all unrelated fields, consent assertions and supplied URLs.
Links are reconstructed server-side from the known mailbox and validated message
IDs. Bodies, notes, access codes and credentials are not imported.

Validate without any database writes:

```sh
npm run import:customer-contacts -- --file /private/inventory.json
```

The existing private inventory was successfully validated as 105 contacts,
345 source references and six bounded batches. Those counts are a working
inventory, not proof that all correspondents are customers or that every
customer/source has been extracted. No real inventory data is committed here.

After the schema is deployed and production is healthy, an owner can use the
JSON file input in the directory. Each successful batch is committed; after an
interruption, upload the same file again to resume without duplicate sources.
Do not change the file while retrying. Only this Gmail mailbox is accepted in
the initial importer.

For an operator import on the correctly configured R2NETTE server:

```sh
npm run import:customer-contacts -- --file /private/inventory.json --apply
```

The command loads the server `.env` if present, uses Prisma's configured database
and prints counts only. `--apply` writes historical CRM evidence; it does not
subscribe, email, verify or create an authentication account. Preserve the
private file securely; never paste it into an issue, commit, image or build log.

## Release and verification

Run the existing CI: migrations from an empty database, schema/migration diff,
typecheck, all tests, safety checks and container. New database integration tests
prove replay and concurrency safety, history bounds, source cascade and no
account/phone/outbox creation. HTTP tests separately enforce owner scope,
pagination, strict mutation schemas, source URL construction and no-store.

Production rollout remains separate from a successful build. Last inspected full
Deploy #38952711773 failed ENOSPC on Contabo; the login-only hotfix is not a full
image release. Verify server storage, protect backups/rollback, apply migrations
through the existing release workflow, then require a non-skipped matching SHA
deployment and health/readiness checks. Test owner search/import/reimport and a
denied non-owner request on the live site before declaring this directory live.
