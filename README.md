# Sportstech Webhook Hub

A central dashboard to create named webhook endpoints, issue individual secret passkeys, control access, store incoming events, and optionally forward each event to another HTTPS service.

## Run locally

Requires Node.js 24.14 or newer. No packages need to be installed.

```sh
cd sportstech-webhooks
npm start
```

Open http://127.0.0.1:4310. On the first launch, the terminal prints a randomly generated admin password. Save it in your password manager. Only its salted scrypt hash is stored. Subsequent starts use the saved password.

To set or reset the administrator password, launch with `ADMIN_PASSWORD` set to a strong password through your secret manager or environment. Supplying this variable replaces the saved administrator password on startup. Existing sessions are in memory and expire after eight hours or a restart.

## Use the dashboard

1. Select **Create webhook** and enter a name and description identifying the sender and the event's purpose.
2. Optionally add a public HTTPS destination. Without a destination, the webhook only receives and stores events. With one, it stores and forwards them.
3. Copy the generated URL and passkey immediately. The passkey is displayed only once and cannot be recovered.
4. Configure your sender to POST UTF-8 JSON or text to the URL with `X-Webhook-Key: YOUR_PASSKEY` or `Authorization: Bearer YOUR_PASSKEY`.
5. Open **Manage** to inspect events, send a test event, edit, pause/resume, rotate its passkey, or delete the webhook.

A passkey here is a server-to-server secret API key, rather than a device or biometric WebAuthn passkey. Each key grants POST access to one endpoint only, without access to the dashboard or stored data. Rotation immediately invalidates the previous key. Pausing rejects incoming events; it does not cancel already accepted forwarding jobs. Deleting permanently removes the endpoint and its event history.

Example:

```sh
curl -X POST http://127.0.0.1:4310/hooks/WEBHOOK_ID \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Key: YOUR_PASSKEY' \
  -d '{"event":"order.created","order_id":"1234"}'
```

A successful request returns HTTP 202 with an event ID and a `stored` or `pending` status. HTTP 202 confirms local acceptance, not downstream delivery. Inspect its history for `forwarded` or `failed`.

## Storage and forwarding behavior

- SQLite persists configuration, key hashes, and event payloads under `data/webhooks.sqlite`; protect and back up the whole data directory. Stop the server before copying the database and any WAL files.
- The latest 1,000 events per webhook are retained; the dashboard displays the latest 100. Counts cover retained history, not lifetime totals. Payloads are stored as UTF-8 text, not binary files.
- Incoming payloads are limited to 1 MB and 120 authenticated requests per webhook per minute. Authentication failures are rejected without storing their payloads. Admin sign-in is limited to 10 attempts per source IP per minute.
- Forwarding POSTs the saved body and original Content-Type, with an `X-Webhook-Event-Id` header. Sender authentication, cookies, and other incoming headers are never forwarded. Only Content-Type, User-Agent, and X-Request-Id are retained as metadata.
- Forwarding uses public IPv4 HTTPS destinations on port 443. Private, local, reserved, and IPv6 destinations are rejected. DNS is validated and the connection is pinned to the resolved address. Redirects are not followed.
- Each event gets one forwarding attempt. HTTP 2xx means success; all other responses and network errors are recorded as failures. There is a 5-second DNS deadline and a 10-second HTTP deadline. At most 50 forwarding jobs run concurrently. **There is no automatic retry, replay, or durable delivery queue in this version.** Jobs interrupted by a restart are marked failed on the next start. A timeout or restart can leave downstream delivery uncertain; use event IDs to deduplicate.
- Use dashboard test events carefully when a destination is configured: they are forwarded to that destination.

## Make it available to other systems

Localhost is only reachable on this computer. For a shared central service, run this application on an always-on server with persistent storage, behind an HTTPS reverse proxy. Configure:

| Variable | Purpose | Default |
| --- | --- | --- |
| `HOST` | Listening interface (use `0.0.0.0` inside a container) | `127.0.0.1` |
| `PORT` | Listening port | `4310` |
| `PUBLIC_BASE_URL` | Canonical public origin, e.g. `https://hooks.example.com` | Local browser origin |
| `ADMIN_PASSWORD` | Set/reset admin password on startup | Saved hash, or generated on first start |

Set `PUBLIC_BASE_URL` to the exact HTTPS origin to generate correct public URLs and enable Secure session cookies. Proxy `/hooks/` and `/api/` to this server, preserve the Host header, and cap request sizes and rates at the proxy. The app does not trust forwarded client-IP headers; behind a proxy the login rate limit is shared unless separate access control is provided upstream.

This version has one administrator account and one SQLite process. Team roles, provider-specific signature verification, forwarding destination authentication, automatic retries, and durable queuing are not included. Do not put destination credentials into URL query strings: destination URLs are visible to the administrator. Public deployment and a domain have not been configured.

## Verify

```sh
npm test
```

Integration tests cover admin authentication, origin protection, creating and deleting hooks, secret redaction, receiving events, rotating keys, pausing/resuming, payload limits, logout, persistence across restarts, forwarding success and failures, and destination restrictions. Forwarding tests use an injected transport; delivery to an actual external service must be verified with your chosen destination.

The server uses Node's built-in SQLite module: https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html
