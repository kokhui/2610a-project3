# SplitLah

When you hang out with friends, one person often pays the whole bill. Later, nobody remembers how much it was, and some people forget to pay the payer back. SplitLah fixes that:

- **Log the bill on the spot.** Record what it was, the total, who paid and how it's split (equally or by exact amounts).
- **See who owes whom.** Every group shows each person's balance and the fewest payments needed to settle everything.
- **Close the loop.** Mark a repayment as paid (partial payments are fine), or send a ready-made WhatsApp reminder that lists the bills and your PayNow number.
- **Groups with invite codes.** Make a group for each friend circle and share the 6-letter code or link.
- **Accounts.** Simple username and password login. Passwords are hashed with scrypt, and sessions use HttpOnly cookies.

## Run it

Needs Node.js 22.13 or newer. There are no packages to install: it uses Node's built-in `node:http` and `node:sqlite`.

```sh
node server.js
# open http://localhost:3000
```

The database is a single SQLite file at `data/splitlah.db`, created on first run. Settings come from environment variables:

| Variable   | Default             | Purpose                                         |
|------------|---------------------|-------------------------------------------------|
| `PORT`     | `3000`              | HTTP port                                       |
| `DB_FILE`  | `data/splitlah.db`  | SQLite database path                            |
| `NODE_ENV` | (unset)             | Set to `production` behind HTTPS for `Secure` cookies |

## Using it with friends

Friends need to reach the server. Some options:

- **Same Wi-Fi:** run it on your laptop and share `http://<your-LAN-IP>:3000`.
- **Online:** deploy to any Node host with a persistent disk (Render, Railway, Fly.io, a VPS). Point `DB_FILE` at the persistent volume, and set `NODE_ENV=production` so the cookie is HTTPS-only.

GitHub Pages won't work, because it only serves static files and this app needs its server and database.

## How it works

- `server.js`: the HTTP server, JSON API, auth and SQLite schema.
- `public/`: the single-page frontend (`index.html`, `app.js`, `style.css`), with hash routes `#/`, `#/g/<id>`, `#/profile` and `#/join/<code>`.

Money is stored as integer cents. When a bill splits equally, any leftover cents go to the first few people, so the shares always add up to the total. Balances are worked out from the bills and repayments each time, not stored. The "settle up" list pairs the biggest debtor with the biggest creditor, which needs at most *n − 1* payments.
