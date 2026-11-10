# 知余 Yuvo

*Every day, a little more room.*

**记下日常，心中有余。**

[中文](README.md) · [English](README.en.md) · [Live demo](https://yuvo.luojie.dev/) · [Data and privacy](docs/privacy.en.md)

[![CI and demo](https://github.com/luojiedev/yuvo/actions/workflows/ci.yml/badge.svg)](https://github.com/luojiedev/yuvo/actions/workflows/ci.yml)

Yuvo is a local-first bookkeeping PWA for individuals and families. Entries and pending operations are committed to browser IndexedDB first, so recording an expense does not depend on a network connection. Cloudflare Workers synchronize incremental changes idempotently with D1, while image attachments are stored in R2.

This repository contains independently deployable source code. It does not contain production accounts, ledger data, attachments, or secrets. Each deployment uses its own Cloudflare resources.

## Try it

Open the **[Yuvo live demo](https://yuvo.luojie.dev/)** to try local bookkeeping, transaction search, statistics, budgets, subscriptions, and import/export without registering an account.

The demo runs on a dedicated Cloudflare Worker with a separate browser database. Ledger contents and images are not uploaded. Accounts, family sharing, cloud synchronization, automatic exchange rates, push notifications, and offline PWA installation require the full self-hosted version. The application interface is currently in Chinese.

Demo data has no cloud backup. Export JSON before clearing browser storage or changing devices. See [data and privacy](docs/privacy.en.md) for details.

## Features

### Fast entry

- Record income and expenses using integer amounts in minor currency units.
- Use the in-app numeric keypad with decimals, backspace, and chained addition, subtraction, multiplication, and division.
- Choose a ledger, account, date/time, category, and subcategory; add a description and up to three images.
- Create and edit categories and subcategories from the entry screen.
- Save immediately to IndexedDB and update the transaction list without waiting for the server.
- Record CNY and USD amounts. The full version can fetch a reference USD/CNY rate, and rates can be entered manually.
- Foreign-currency entries freeze their CNY settlement amount and rate snapshot. Statistics, budgets, calendars, and amount filters use the frozen CNY amount.

### Transactions, search, and statistics

- Group entries by local date with daily income/expense totals and creator information.
- Open entry details, edit or delete entries, and use swipe actions on mobile.
- Browse daily expenses on a monthly calendar with month/year selection.
- Search descriptions, categories, subcategories, accounts, creators, amounts, and currencies.
- Combine date, income/expense, amount, category, account, member, and statistical-inclusion filters.
- Explore monthly and yearly trends, same-period comparisons, category/account/member rankings, budget usage, and expense forecasts.
- Drill down from rankings into the corresponding transaction period.
- Date grouping uses the device's local time zone. Members in different time zones may see a near-midnight transaction in different days or months.

### Budgets, subscriptions, and portability

- Each ledger has an independent monthly budget, initially CNY 3,000. Owners and administrators can edit it.
- Budget usage counts statistical expenses in the current local month through today, including frozen CNY settlements for foreign-currency entries.
- Show remaining budget, usage percentage, and a daily allowance based on the remaining days in the month.
- Manage recurring subscriptions with a service name, beneficiary, amount, currency, billing frequency, and next charge date.
- Confirm each subscription charge manually. Stable period identifiers prevent duplicate entries from repeated clicks or sync retries.
- Export a versioned JSON backup of the current ledger, including locally available attachments, or exchange transactions through UTF-8 CSV.
- Repeated JSON/CSV imports safely skip restored entries. CSV exports protect against spreadsheet formula injection and preserve currency and settlement information.

### Accounts and family sharing

- The first user initializes the instance. Later accounts require a single-use invitation; public registration is unavailable.
- Each person has an independent account and device identifier, a private ledger, and access to authorized family ledgers.
- Create local ledgers offline, attach them to an account at login or later, and synchronize the account's ledgers and images.
- Family roles are `owner`, `admin`, `member`, and `viewer`. The current interface primarily supports owners and administrators managing a ledger together.
- Transactions, catalogs, accounts, attachments, and budgets synchronize within ledger boundaries. Private and family ledgers are separately authorized.
- Entries retain creator information; display-name changes synchronize to other devices.
- Local databases are separated by account. Logout locks the account's local space while retaining its cached data and pending operations.
- Legacy data requires online account verification before migration. Data with uncertain ownership remains preserved and locked. See the [recovery notes](docs/first-batch-recovery.md), currently in Chinese.

### Local-first sync and PWA

- Business records and Outbox operations commit in the same IndexedDB transaction.
- Stable operation identifiers and stored server results make retries idempotent.
- Updates and deletions use optimistic version checks; conflicts are not silently overwritten.
- Sync runs at startup, after reconnecting, on return to the foreground, and on explicit request.
- Startup displays local data first, then refreshes remote changes in the background.
- Authenticated D1 snapshots can restore authorized ledgers. R2 attachments download through authenticated endpoints and are cached locally.
- The full PWA caches its application shell and static assets for offline startup, includes iOS icons and startup images, and shows installation/update status.
- Optional Web Push notifies signed-in users about other family members' new entries. Tapping a notification opens the related transaction.
- Text and amount input controls use at least 16px fonts to avoid focus zoom in iOS Safari/PWA. Repository changes must follow `AGENTS.md`.

## Architecture

```text
React UI
  ↓ local reads and writes
IndexedDB: ledger mirror, Outbox, cursors, attachment cache
  ↓ batched push / incremental pull
Cloudflare Workers API
  ├─ D1: accounts, ledgers, entries, permissions, sync history, notifications
  ├─ R2: original image files
  └─ Web Push: encrypted delivery to browser push services

Service Worker → application shell and static asset cache
```

The frontend uses React, TypeScript, Next.js/Vinext, and Vite. The backend runs on Cloudflare Workers. Drizzle manages the D1 schema, and production schema changes use versioned migrations under `drizzle/`.

## Current limitations

The following capabilities are not complete and should not be assumed available:

- Transfers between accounts and account balance calculation.
- Member-list management, removal/leaving a family ledger, and role-management screens.
- Complete user-facing sync conflict comparison and recovery workflows.
- Ledger editing/archiving, category sorting/restoration, and full attachment garbage collection.
- AI categorization, import previews, arbitrary CSV column mapping, large streamed ZIP backups, and all-ledger export.
- Reliable continuous background synchronization. iOS restricts background execution; changes are checked at startup, on foreground return, after reconnecting, or through manual sync.

The WeChat in-app browser is unsupported. Use Safari, Chrome, or the installed PWA.

## Data and privacy

- Signed-out ledger contents stay in the current browser. Once a ledger is attached to an account, its data and images synchronize to the operator's own D1 and R2 resources.
- Local account separation does not encrypt the database. The full application uses HTTPS transport but does not provide end-to-end encryption.
- Logout retains local data and pending operations. Clearing site data removes local copies; export unsynchronized data first.
- JSON/CSV exports are not encrypted and contain private financial information.
- Read the [full data and privacy explanation](docs/privacy.en.md) for storage locations, sharing, notifications, exchange-rate services, logs, deletion, and recovery boundaries.

## Requirements

- Node.js 22.13 or newer.
- pnpm 11.10, pinned through `packageManager` in `package.json`.

Use pnpm for this repository. Do not run `npm install`; the lockfile is `pnpm-lock.yaml`.

## Local development

```bash
corepack enable
pnpm install
cp wrangler.example.jsonc wrangler.jsonc
pnpm run cf:migrate:local
pnpm dev
```

The development server listens on `0.0.0.0`; use the Local URL shown in the terminal. A phone on the same network can use the computer's LAN IP and the same port.

`wrangler.jsonc` is ignored by Git. Local D1 and R2 run through Cloudflare's simulator and do not access production data. Migration can be skipped when only viewing the local interface; migrate before using account or synchronization APIs.

For local push testing, copy `.dev.vars.example` to `.dev.vars` and supply your own VAPID configuration. This file is unnecessary when not testing push notifications.

## Checks

```bash
pnpm test
pnpm run test:local-db
pnpm run test:worker
pnpm run typecheck
pnpm run lint
pnpm run cf:types:check
```

`pnpm test` performs a production build and runs frontend domain/render tests. The other commands cover IndexedDB and client logic, Worker/D1/R2 integration, TypeScript, linting, and generated binding types.

## CI and demo publishing

The [GitHub Actions workflow](.github/workflows/ci.yml) runs for pushes to `main`, pull requests, and manual dispatches. It uses Node.js 22 and the pinned pnpm version, installs with `--frozen-lockfile`, and runs all checks listed above.

It also builds the local-only demo with `pnpm run demo:build`, using root-relative asset paths. Once Cloudflare deployment credentials are configured, successful checks on `main` publish the demo. Pull requests run checks and build the demo without replacing the public site.

The separate [wrangler.demo.jsonc](wrangler.demo.jsonc) configures the `yuvo-demo` Worker and `yuvo.luojie.dev` custom domain. It does not bind the full application's D1, R2, Images, or VAPID secrets.

For the first manual deployment:

```bash
pnpm exec wrangler login
pnpm run demo:deploy
```

The domain's zone must be active in the same Cloudflare account. Wrangler binds the domain through `routes[].custom_domain`. For your own fork, change the Worker name, domain, and README links. Confirm the purpose of any existing website before replacing its domain records.

For GitHub publishing, configure **Settings → Secrets and variables → Actions**:

- Repository secret `CLOUDFLARE_API_TOKEN`: use Cloudflare's **Edit Cloudflare Workers** template, restricting the account and zone scopes to the resources needed for deployment.
- Repository variable `CLOUDFLARE_ACCOUNT_ID`: the deployment account's Account ID.

Without the Account ID variable, CI runs checks and builds the demo but skips publishing. Once both values are configured, push to `main` or dispatch the workflow to publish. The `cloudflare-demo` deployment environment displays the live URL.

Demo output is written to `dist-demo/`. The build does not load the private deployment configuration or root `.env*` files. It requires no D1/R2 resources or VAPID secrets; use the instructions below for the full backend deployment.

## Deploy the full application to Cloudflare

Sign in to your own Cloudflare account and create independent resources:

```bash
pnpm exec wrangler login
pnpm exec wrangler d1 create yuvo-db
pnpm exec wrangler r2 bucket create yuvo-attachments
```

Copy `wrangler.example.jsonc` to `wrangler.jsonc` and configure:

- Your Worker `name`.
- The real `database_id` returned by Cloudflare, replacing the placeholder UUID.
- Matching `database_name` and `bucket_name` values.
- Access to the required D1, R2, and Images services. Resource permissions and charges are managed by the deployer.

Keep the application binding names `DB`, `ATTACHMENTS`, `IMAGES`, and `ASSETS` unchanged.

Before enabling push notifications, generate one long-lived VAPID key pair:

```bash
node --input-type=module --eval 'import { generateVapidKeys } from "@mmmike/web-push/vapid"; console.log(await generateVapidKeys())'
```

Store the public key, private key, and contact URI, such as `mailto:admin@example.com`, as Worker secrets:

```bash
pnpm exec wrangler secret put VAPID_PUBLIC_KEY
pnpm exec wrangler secret put VAPID_PRIVATE_KEY
pnpm exec wrangler secret put VAPID_SUBJECT
```

Use the same names in the ignored `.dev.vars` file for local testing. Keep the key pair stable once devices subscribe; changing the public key requires resubscription.

When adding a D1 migration, migrate before deploying:

```bash
pnpm run cf:migrate:remote
pnpm run cf:deploy
```

Without schema changes, run only `pnpm run cf:deploy`. Complete the checks before deployment. Never commit passwords, access tokens, or other secrets.

`pnpm run build` uses local `wrangler.jsonc`, falling back to the example when absent. The Cloudflare plugin generates the deployment configuration used by Wrangler. Fill in your actual local resource configuration before deploying; the placeholder UUID cannot be used in production.

Immediately after the first deployment, open your site and create the owner account. Later accounts require single-use invitations. Publishing the source does not open registration or grant access to an existing instance.

Launch messages are stored in D1's `app_messages` table. Customize active records with `placement = 'launch'` in your own database; private text does not need to enter the repository.

`private: true` in `package.json` prevents accidental npm publication. It does not prevent a public GitHub repository or independent deployment.

## Repository layout

- `app/`: React screens, interactions, and global styles.
- `lib/`: domain logic, IndexedDB, search, import/export, and sync.
- `worker/`: Cloudflare API, authentication, authorization, sync, and attachments.
- `db/` and `drizzle/`: D1 schema, migrations, and metadata.
- `public/`: Service Worker, manifest, icons, and startup images.
- `tests/` and `worker-tests/`: client/domain tests and backend integration tests.
- `demo/` and `vite.demo.config.ts`: standalone local-only demo entry and build.
- `.github/workflows/ci.yml`: automated checks and Cloudflare demo publishing.
- `wrangler.demo.jsonc`: dedicated demo Worker and custom-domain configuration.
- `docs/privacy.md` and `docs/privacy.en.md`: Chinese and English data/privacy documentation.
- `AGENTS.md`: repository implementation checkpoints for Agents.
- `DEVELOPMENT_PLAN.md` and `IMPLEMENTATION_PLAN.md`: current roadmap and detailed implementation history, currently in Chinese.

## License

Yuvo is licensed under the [MIT License](LICENSE). Third-party dependencies retain their respective licenses.
