# Data and privacy

[中文](privacy.md) · [Back to README](../README.en.md)

This document describes the current repository implementation. Each self-hosted instance is managed by its operator. Operators must separately disclose any analytics, proxies, logging, or other services they add.

## Public demo

The [live demo](https://yuvo.luojie.dev/) is hosted on a dedicated Cloudflare Worker and provides a local-only experience:

- Ledgers, transactions, categories, accounts, budgets, subscriptions, and selected images stay in a dedicated database in the current browser. They are not uploaded to a ledger server.
- The demo build blocks application API calls and uses a `connect-src 'none'` content security policy. Login, family sharing, cloud sync, automatic exchange rates, and push notifications are unavailable.
- The demo does not register a Service Worker or provide offline PWA installation. Reloading requires a network connection; saved demo entries remain in browser storage.
- Requests for the page and static assets still reach Cloudflare. The hosting platform may process request information such as IP addresses and browser details under its own policies.
- The demo uses `swift-ledger:demo-v1`. It does not open normal account databases or inspect and migrate legacy ledgers.
- Browser storage is isolated by origin; a URL path is not a security boundary. Other applications on the same origin may share storage access.

The demo has no cloud backup. Clearing site data, private browsing, browser storage eviction, or changing devices can make entries unrecoverable. Export a JSON backup through “我的 → 导入与导出” before clearing storage.

## Storage in a self-hosted instance

| Data | On the device | In the operator's cloud resources |
| --- | --- | --- |
| Ledgers, transactions, categories, accounts, budgets, subscriptions | Local copies in IndexedDB | D1 after login and account attachment |
| Images | Original files or downloaded copies in IndexedDB | R2 during authenticated sync; metadata in D1 |
| Pending operations, sync cursors, recovery records | IndexedDB | Separate server change, version, and idempotency records |
| Sessions | Access token and session information in IndexedDB | Token hashes, expiration, and revocation state in D1 |
| Account and device information | Current session and device identifiers | Username, display name, device identifiers, and related records in D1 |
| Passwords | Processed by the page during entry; excluded from backups | Random salt and PBKDF2-SHA-256 derived value |
| Preferences, recent ledger, exchange-rate cache | localStorage | Related business settings synchronize where supported |
| Application shell and static assets | Service Worker Cache Storage | Hosted application assets |

While signed out, ledger contents stay on the device and are not automatically uploaded. The full version still requests same-origin launch messages and bootstrap status; selecting a foreign currency can request an exchange-rate quote.

At login, users may attach local ledgers to their account, or do so later through ledger management. Once attached, entries, attachments, and related settings synchronize under account and ledger permissions. Using the source code does not grant the repository author access to your instance. The instance operator and people with cloud-resource access can administer its D1, R2, and runtime logs.

## Accounts, sharing, and access boundaries

- Accounts use separate local databases. Signing out clears the local session for that account and returns to guest storage, while keeping cached data and pending operations.
- Local account isolation is application access control, not database encryption. Someone with access to the browser profile, developer tools, or device files may be able to read local data.
- Private and family ledgers have separate authorization. Authorized family members can access shared transactions, descriptions, attachments, and creator names according to their roles.
- The implementation does not provide end-to-end encryption. HTTPS protects transport; the server can read ledger content to perform synchronization, queries, and notification processing.
- Use HTTPS for your deployment, protect devices and cloud accounts, and share invitations with trusted people.

## External services, notifications, and logs

- The full application uses the operator's Cloudflare Workers, D1, R2, and Images configuration. Hosting logs, storage location, retention, and backups depend on the operator and provider configuration.
- The Worker queries Frankfurter for USD/CNY reference rates. A quote requires the currency pair, not transaction amounts, descriptions, account details, or attachments. Rates can also be entered manually.
- Push notifications require user permission. D1 stores push endpoints, subscription keys, and user/device associations. Notifications are delivered through the browser or operating system's push service.
- Family notification bodies include the creator's display name, income/expense type, and category. Their target URLs contain ledger and transaction identifiers. Lock-screen previews may reveal notification content; control previews in device settings.
- Browser debug logs and structured server logs can include request, user, device, and entity identifiers, operation state, and errors. Remove tokens, invitations, push endpoints, and private entries before sharing logs or filing an issue.
- The current application code does not integrate third-party advertising, analytics, or behavioral tracking SDKs. Hosting platforms may still process network request information.

## Deletion, retention, and recovery

- Deleting a transaction records a deletion state and propagates it through sync. It does not immediately erase all server records, sync history, attachments, or backups.
- Complete account deletion, comprehensive data erasure, and automatic attachment garbage collection are not implemented. Contact your instance operator for cloud-data removal across databases, attachments, backups, and logs.
- Signing out, removing a home-screen icon, and clearing site data have different effects. Signing out keeps ledger data; removing an icon does not guarantee removal of browser storage.
- Clearing site data removes local ledgers, sessions, and caches. Only successfully synchronized data that your account can still access can be restored from the server. Export unsynchronized entries first.
- Changing domains or origins does not automatically move local browser data. Complete sync and keep a JSON backup before moving to a new origin.

## Imports and exports

- JSON backups include the current ledger, budget, accounts, categories, transactions, subscriptions, and locally available images. Missing attachments must be downloaded first.
- CSV exports exchange transactions; they do not include the complete ledger structure or images.
- Backups exclude passwords, session tokens, invitation tokens, and notification subscriptions. They still contain private descriptions, amounts, creator information, and attachments.
- Exported files are not encrypted. Store them somewhere trusted. Uploading them to another service subjects them to that service's handling.
- Format and idempotent import details are documented in the [import and recovery design](import-export.md), currently in Chinese.
