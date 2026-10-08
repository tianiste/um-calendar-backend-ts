# Plan: port UM Calendar API to TypeScript on Cloudflare

## Objective

Port `../backend-go` into this repository and push small, verified commits to
`git@github.com:tianiste/um-calendar-backend-ts.git` on `main`.

Hosting must be free within published quotas, require no payment card, and have
no container sleep or idle wake-up delay. Calendar refreshes must continue when
the GitHub repository receives no commits.

## Current state

- The new repository has the initial README commit and an `origin` remote.
- An initial Worker scaffold was created before this plan was requested. It is
  uncommitted and has not been pushed. Implementation is paused for plan review.
- The scaffold's health/CORS integration check and TypeScript check passed.
  These checks cover only the scaffold, not the complete port.
- No database, scraper, calendar endpoint, Cron Trigger, or cloud deployment
  has been implemented in this repository.
- The source index was checked on 2026-10-08: 64 valid calendars, a roughly
  15 KB index, and listed calendar sizes below 100 KB. Counts can change.

## Architecture

Use one TypeScript Cloudflare Worker and one Cloudflare D1 database. Use native
Workers APIs, HTMLRewriter, SQL, and fetch; avoid a web framework, ORM, external
Postgres service, and runtime parsing dependencies.

```text
University calendar index -- hourly Cron Trigger --> D1 calendar links
University ICS files ------ small scheduled batches --> D1 content and sync state
Frontend ------------------ GET requests -----------> Worker --> D1 / university
```

The Worker replaces the Go HTTP server. D1 replaces Postgres and stores the
latest successful calendar content, validators, hash, and sync timestamps.
Calendars are rebuilt from the university source; no private user data or
existing Postgres data needs migrating for these three endpoints.

Use Cloudflare Cron Triggers for refreshes. GitHub Actions may run CI, but will
not own scraping: public repository schedules stop after 60 days without
repository activity and can be delayed or dropped.

## API compatibility

| Request | Required behavior |
| --- | --- |
| `GET /health` | HTTP 200, JSON `{ "message": "pong" }`; liveness only |
| `GET /data/names` | HTTP 200, sorted JSON `string[]` of calendar filenames |
| `GET /data/cal/:name` | HTTP 200, raw ICS, `text/calendar; charset=utf-8` |
| Unknown calendar | HTTP 404 |
| Upstream connection failure or timeout | HTTP 502 for calendar download |
| Upstream non-200 response | Preserve the Go calendar endpoint's HTTP 404 behavior |
| Invalid upstream ICS response | HTTP 502; never replace a valid cached calendar with HTML/error content |
| Database failure | HTTP 503; log the failure without exposing configuration |

Keep the `.ics` extension in names, preserve decoded filenames, and support
`encodeURIComponent(name)` as used by the existing Vue client. Preserve
`X-Cache: HIT` / `MISS` for calendar responses. Handle malformed URL encoding
with a controlled client error.

Keep CORS access for `https://um-calendar-frontend.pages.dev` and
`https://umcalendar.com`, `GET`/`OPTIONS`, and `Content-Type`. Return the exact
allowed origin and `Vary: Origin`, including on error responses.

Port per-IP rate limiting using the platform binding if available on the free
account. Its window-based limits differ from Go's token bucket; document the
chosen equivalent and verify configuration. Do not silently remove the limiter
or claim identical burst behavior.

## Freshness and failure behavior

1. Refresh the index hourly, for example at minute 17 in UTC. Parse links with
   HTMLRewriter, resolve relative URLs, accept only the university's exact
   origin and calendar directory, and skip the placeholder with no code.
2. Upsert by calendar code. Preserve the Go behavior of retaining old rows;
   do not delete calendars just because they disappear during one scrape.
   When a source URL changes, clear the corresponding cached content and
   validators so an old URL's data cannot be served as the new calendar.
3. Run a second trigger every minute. Select at most two calendars whose last
   attempt is at least an hour old, oldest first, and refresh them sequentially
   or with at most two outgoing requests. At the current count, capacity is
   120 refresh attempts per hour for 64 calendars.
4. Track successful check time separately from attempt time. A failing file
   must not starve all other calendars or be treated as successfully refreshed.
   Failed background attempts preserve previously successful data and produce
   structured logs; do not report the sync as wholly successful.
5. Preserve the Go API's five-minute cache freshness window on user requests.
   A requested calendar older than five minutes is conditionally revalidated
   before returning it, even if the background refresh has not reached it.
   A failed revalidation returns an error rather than silently returning old
   content as fresh. A 304 can reuse existing content and advance its check
   timestamp; never accept a 304 when no content is stored.
6. Preserve ETag and Last-Modified validators, including when a 304 omits them.
   Use SHA-256 to detect changes when the source has no validators. Store
   updated content and sync metadata together and prevent an older concurrent
   fetch from overwriting a newer successful result.
7. Bootstrap an empty database by scraping the index on the first names
   request. Calendar content can be fetched on demand; users should not need
   to wait for the entire first scheduled sweep.

Hourly background refresh and a five-minute request cache match the original
freshness expectations. This does not promise instant publication of every
university change or availability when the university itself is down.

## Free-tier budget and gates

Published limits checked on 2026-10-08:

| Resource | Free allowance | Planned use / check |
| --- | --- | --- |
| HTTP requests | 100,000/day | Depends on real client traffic; inspect account metrics |
| Cron Triggers | 5/account | 2 for this backend; check other account usage |
| CPU | 10 ms per HTTP or cron invocation | Keep index parsing separate from two-file refreshes; measure remotely |
| Outgoing subrequests | 50/invocation | Small refresh batches; never fetch all calendars in one invocation |
| D1 queries | 50/invocation | Bulk index upsert in one SQL query, not one query per calendar |
| D1 reads | 5 million rows/day | Indexed calendar lookup; names results contain 64 rows currently |
| D1 writes | 100,000 rows/day | Approximately 1,536 successful scheduled calendar checks/day before indexes and bookkeeping |
| D1 database size | 500 MB/database | Store current content only, no history; measure actual storage |
| D1 total storage | 5 GB/account | One database; shared with other account workloads |
| D1 row size | 2 MB | Bound content size below this and validate before writing |

The write estimate is `64 * 24` for successful hourly checks. Actual usage
includes attempt timestamps, changed content, indexes, catalog updates, and
on-demand refreshes. Only update unchanged index rows when necessary. Do not
confuse rows written with SQL query count.

The quota estimates fit the current catalog. CPU is an unresolved release gate:
local correctness checks cannot prove that Cloudflare's 10 ms limit is met.
Measure representative index parsing, changed/unchanged ICS, and cold/cache-hit
requests in the deployed Worker. If over budget, reduce scheduled batch size or
avoid work that does not affect responses, while retaining a demonstrated
refresh cadence. Do not upgrade to paid hosting or fall back to an unattended
GitHub schedule to make the gate pass.

Free means bounded usage, not unlimited traffic. Exceeding Workers or D1 free
quotas can cause errors until limits reset. Keep the Cloudflare account on the
free plan and verify other workloads do not consume the necessary headroom.

## Incremental implementation and pushes

Each implementation slice must type-check, bundle, pass its focused checks,
and be reviewed for secrets and unintended behavior before committing. Push
each successful commit to `origin/main` without force-pushing. Update this
checklist in the corresponding commit. Do not stage unfinished later slices.

### 0. Record the plan

- [x] Commit and push only `PLAN.md`, leaving the existing scaffold uncommitted.
- [ ] Review the plan before continuing implementation.

### 1. Worker foundation

Files: `package.json`, lockfile, `tsconfig.json`, `wrangler.jsonc`, `.gitignore`,
`src/index.ts`, and the small integration harness. This is the one tooling
slice that necessarily reaches more than five files.

- [ ] Review the existing scaffold against this plan and pin tool versions.
- [ ] Provide health, allowed-origin CORS, preflight, controlled unknown routes,
      and method handling with no runtime framework dependency.
- [ ] Ensure generated files, credentials, local state, and environment files
      are ignored.

Verification: `npm run check`, Worker dry-run bundle, and integration checks
covering health, allowed/disallowed origins, preflight, and unknown routes.

Commit: `feat: establish the Cloudflare Worker API`.

### 2. Calendar catalog and names endpoint

Files: `migrations/0001_calendars.sql`, `src/catalog.ts`, `src/index.ts`,
`wrangler.jsonc`, and catalog integration checks.

- [ ] Add the D1 schema, name/refresh indexes, and sync timestamps; migrations
      must run explicitly before deployment, not on every request.
- [ ] Parse source links safely and perform a parameterized bulk upsert using
      JSON in one statement to avoid the 50-query limit.
- [ ] Implement sorted names and first-use bootstrap; a failed or empty scrape
      must not erase a working catalog.

Verification: apply the local migration; use the Workers runtime and real local
D1 with mocked upstream HTML covering relative/encoded links, duplicate codes,
foreign links, placeholders, empty responses, and URL changes. Confirm the
current real index can be parsed without writing to a production database.

Commit: `feat: persist the calendar catalog in D1`.

### 3. ICS endpoint and cache freshness

Files: `src/calendar.ts`, `src/index.ts`, API integration checks, and any required
schema correction before the migration is used remotely.

- [ ] Implement lookup, safe upstream requests with a 30-second timeout,
      content validation/size limits, conditional fetch, hash, and five-minute
      cache behavior.
- [ ] Preserve status codes and `X-Cache`; handle 304, changed URLs, failed
      writes, and concurrent results without corrupting successful data.
- [ ] Add the supported rate-limiting binding and log errors without secrets.

Verification: cold download, cache hit, expired cache/304, changed body, missing
calendar, invalid encoding, network failure, upstream HTML, source URL change,
and failure to persist. Test the rate limiter separately so it does not make
other integration checks flaky.

Commit: `feat: serve fresh calendars with conditional caching`.

### 4. Scheduled refreshes

Files: `src/index.ts`, `src/catalog.ts`, `src/calendar.ts`, `wrangler.jsonc`, and
scheduled integration checks.

- [ ] Configure the hourly catalog trigger and minute-based two-calendar
      refresh trigger, with no public admin/write endpoint.
- [ ] Select oldest due attempts, record success separately, and make failed
      files yield to the rest of the queue.
- [ ] Add structured success/failure logs and preserve successful cached data
      on background failures.

Verification: trigger both schedules locally; demonstrate batch limits,
no unnecessary checks of recently attempted calendars, 64-calendar rotation,
and recovery after one or more source failures. A scheduled failure must be
visible in logs/metrics.

Commit: `feat: refresh calendars with Cloudflare Cron Triggers`.

### 5. Deployment instructions and final review

Files: `README.md`, `PLAN.md`, and a minimal GitHub CI workflow if appropriate.

- [ ] Document free-account signup, Wrangler login, D1 creation, binding the
      actual database ID, local/remote migrations, deploy, and log inspection.
- [ ] Document how to set frontend `VITE_API_BASE` to the Worker origin. The
      client contract stays the same; an actual frontend deployment requires
      the final Worker URL.
- [ ] Document cache freshness, free limits, rate-limit differences, and
      recovery/rollback. CI checks code; scraping remains on Cloudflare.

Verification: all focused checks and TypeScript/bundle checks pass; inspect the
final diff and pushed commit history; confirm the repository has no unfinished
implementation changes or secrets. Live verification is a separate gate if
Cloudflare account access is not available.

Commit: `docs: document free deployment and freshness checks`.

## Deployment prerequisites and live acceptance

Implementation can proceed after review without Cloudflare credentials.
Deployment needs access to the intended free Cloudflare account and a created
D1 database ID. Do not fabricate an ID or claim that a dry run is a deployment.

When account access is available:

- [ ] Apply D1 migrations and deploy the Worker on the free plan.
- [ ] Confirm health, real names, and a real calendar at the public HTTPS URL.
- [ ] Confirm the production frontend's CORS and base URL.
- [ ] Measure invocation CPU and D1 usage on representative requests and both
      scheduled jobs, including an unchanged calendar response.
- [ ] Observe successful scheduled checks and ensure all 64 calendars rotate
      within the intended interval under normal upstream conditions.
- [ ] Confirm no card, paid subscription, sleeping container, or GitHub
      repository activity is required to keep serving and refreshing.

## Sources

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Rate-limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [GitHub scheduled workflow rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
