# UM Calendar API on Cloudflare

Live API: **https://um-calendar-api.tian-istenic34.workers.dev**.

Custom domain `api.umcalendar.com` is configured in Wrangler but pending removal of the old Azure `api` CNAME. In Cloudflare DNS for `umcalendar.com`, remove only the `api` CNAME targeting `um-calendar-api-gccvc9ddckggd5bj.italynorth-01.azurewebsites.net`, then run `npm run deploy`. Cloudflare manages the new DNS record and HTTPS certificate. Verify `/health` and `/data/names` before setting `VITE_API_BASE=https://api.umcalendar.com`.

TypeScript port of `../backend-go`, using one Cloudflare Worker and D1. No runtime framework, Postgres, or container. See [PLAN.md](PLAN.md) for requirements and live acceptance gates.

| Request | Response |
| --- | --- |
| `GET /health` | `{"message":"pong"}` (liveness only) |
| `GET /data/names` | Sorted JSON filenames, including `.ics` |
| `GET /data/cal/:name` | Raw `text/calendar; charset=utf-8`; encode the filename with `encodeURIComponent` |

CORS allows `https://um-calendar-frontend.pages.dev` and `https://umcalendar.com`. Unknown calendars return 404, upstream connection/invalid-content failures 502, and database failures 503. Upstream non-200 responses return 404. Rate-limited requests return 429.

## Local development

Use Node 22 or newer:

```sh
npm ci
npm run check
npm test
npx wrangler d1 migrations apply DB --local
npm run dev
```

Tests use the Workers runtime, local D1, and mocked upstream responses. `npm run build` produces a dry-run bundle; it does not deploy. Local data lives under `.wrangler/`.

## Deploy on a free account

Create a Cloudflare account and keep Workers on the Free plan. Do not select a paid subscription or add a payment card. Deployment requires access to that account; this repository does not include credentials or an invented database ID.

```sh
npx wrangler login
npx wrangler whoami
npx wrangler d1 create um-calendar
```

Copy the returned database ID into the `DB` binding in `wrangler.jsonc`. Keep `database_name` consistent with the created database. Verify the rate-limit namespace is unique within your account so other Workers do not share its counters. Then:

```sh
npx wrangler d1 migrations apply DB --remote
npm run deploy
npx wrangler tail --format json
```

Use the HTTPS Worker URL printed by deployment:

```sh
curl https://YOUR-WORKER.workers.dev/health
curl https://YOUR-WORKER.workers.dev/data/names
curl -H 'Origin: https://umcalendar.com' https://YOUR-WORKER.workers.dev/data/names
```

Download an encoded filename returned by `/data/names`, repeat for a cache hit, and verify an expired download revalidates. Set the Vue deployment's `VITE_API_BASE` to the Worker **origin only**, without `/data` or a trailing path, then rebuild the frontend. Frontend deployment is separate.

## Refreshes and recovery

An hourly Cron Trigger refreshes the catalog at minute 17 UTC. A second trigger runs every minute and refreshes at most one calendar, oldest attempts first, with an hour between attempts. Cron runs independently of GitHub repository activity. The first names request bootstraps an empty catalog; downloads populate content on demand. The one-file batch keeps measured CPU within the free-tier target. Capacity is 60 attempts/hour for the current 58 stored calendars; more than 60 calendars would require measured optimization to retain an hourly sweep. The source check on 2026-10-08 found 64 valid links and 58 unique codes. Like the Go repository, D1 stores one row per code, with the last source link winning for duplicate codes.

Requests reuse successfully checked content for five minutes (`X-Cache: HIT`). Older content is conditionally revalidated (`MISS`); 304 preserves existing content and validators. Failed background checks retain successful data, but failed request revalidation returns an error. Removed source entries are retained; URL changes invalidate the associated content.

Inspect structured sync logs with `wrangler tail` and the dashboard. After an upstream outage, due calendars retry automatically; no database clearing is necessary. Before rollback, preserve D1 data, inspect migration compatibility, and use `npx wrangler rollback` for a compatible previous Worker version. Worker rollback does not undo D1 migrations; use D1 Time Travel for data recovery after checking the intended restore point.

## Quotas and release gates

The Free plan has [100,000 Worker requests/day and 10 ms CPU/invocation](https://developers.cloudflare.com/workers/platform/limits/). [D1 includes 5 million rows read/day, 100,000 written/day, and 5 GB total storage](https://developers.cloudflare.com/d1/platform/pricing/). Other account workloads share allowances; exceeding free quotas can cause service errors. Two of the account's five free Cron slots are used here.

The [platform rate limiter](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) uses a window and location-local counters. It permits 50 requests per 10 seconds per IP; it differs from Go's 5 requests/second token bucket with burst 20. Shared IPs share the limit. Verify binding availability and behavior in the actual free account.

Before calling the deployment accepted, measure remote CPU for catalog parsing, cold/changed/unchanged downloads and cache hits; check D1 rows and storage; observe a complete scheduled rotation. Local tests cannot prove the 10 ms CPU budget or live Cron operation. Keep scraping on Cloudflare, even when GitHub receives no commits. CI validates code and never deploys or scrapes.
