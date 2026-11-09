# PanelZilla 🦖

A Docker-based game server hosting website in the spirit of **Pterodactyl** — with a built-in **store** where customers buy game servers (Minecraft, Rust, ARK, Valheim, CS2, …) that are provisioned automatically onto a Docker node.

PanelZilla is an original implementation inspired by the public, MIT-licensed concepts of Pterodactyl: the **panel → node daemon** split, **eggs** (game templates referencing public Docker images such as `itzg/minecraft-server`), the `/api/client` API shape, live console streaming, per-server isolation and limits, backups and subusers. Pterodactyl® is a trademark of its respective owner; no Pterodactyl code is copied here.

## Architecture

```
 browser ──► panel (Node/Express, :80) ──► wings (node daemon, :3001) ──► "game server containers"
                │  store · auth · API          │  provision · power · console · files · backups
                ▼                             ▼
          SQLite (volume)               data volume (files/logs/backups)
```

| Service | What it does |
|---|---|
| `panel` | Website: landing page, store, cart & demo checkout, dashboard, server manager, Pterodactyl-style client API (`/api/client/...`) |
| `wings` | Node daemon with a Wings-style HTTP API. Manages each server's lifecycle, console log stream (SSE), file manager, tar.gz backups and resource stats. Swap `WINGS_URL` to point at a real Wings daemon on a game node. |
| `redis` | Cache/session service (optional) |

## Features

- 🛒 **Store** — 10 game eggs × 4 plans (RAM/CPU/disk/slots/price), cart, demo checkout, order history
- 🐳 **Docker-first** — one-command `docker compose up`, isolated services, named volumes for all state
- 🥚 **Eggs** — Pterodactyl-style game templates (`src/eggs.js`) using public Docker images
- 🖥️ **Live console** — real-time SSE console stream + send commands
- ⚡ **Power controls** — start / stop / restart / kill
- 📁 **File manager** — browse, edit, create, delete server files in the browser
- 💾 **Backups** — create, download (`.tar.gz`), restore, delete
- 👥 **Subusers** — invite users with granular permissions (console, power, file, backup, settings)
- 📊 **Stats** — live memory / CPU / disk / network / uptime
- 🔐 **Auth** — bcrypt-hashed passwords, httpOnly session cookies

## Run with Docker

```bash
cp .env.example .env        # then edit the secrets
docker compose up -d --build
```

Open **http://localhost** → Store → add a plan to the cart → checkout (demo payments: any card works) → your server appears in the **Dashboard** and can be started from there.

## Run locally (development, no Docker)

```bash
npm install
npm run wings &   # node daemon on :3001
npm start         # panel on :3000  → http://localhost:3000
```

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Panel listen address |
| `DB_PATH` | `data/panelzilla.db` | SQLite database file |
| `SESSION_SECRET` | dev value | Session signing secret |
| `WINGS_URL` | `http://localhost:3001` | Node daemon URL |
| `WINGS_API_KEY` | dev value | Shared secret between panel and daemon |
| `WINGS_NODE` | `node-1` | Node name shown in the UI |
| `DEMO_PAYMENTS` | `true` | Simulate payments (no real gateway) |

## 🛡️ Admin area

An admin dashboard is available at **/admin** (visible in the nav for admin users only):

- **Overview** — total users/servers/orders, demo revenue, servers per game, live server states, recent orders
- **Users** — list all customers with server/order counts and spend; promote/demote admins; delete users (removes their servers too)
- **Servers** — every server on the node with owner, game, plan and live state; start/restart/stop/destroy any server
- **Orders** — all orders with customer, totals and payment references

The admin API lives under `/api/admin/*` (session auth + `is_admin` check).

A bootstrap admin account is created automatically on first boot:

```
ADMIN_EMAIL=admin@panelzilla.gg     (default)
ADMIN_PASSWORD=admin12345          (default — ALWAYS override in production!)
```

Set both via environment variables (e.g. in `.env`) before `docker compose up`.

## API overview

Store (public): `GET /api/store/games`, cart + checkout under `/api/store/*` (auth required).

Client API (Pterodactyl-shaped, session auth):
`GET /api/client`, `GET /api/client/servers`, `GET|PATCH /api/client/servers/:uuid`,
`POST /api/client/servers/:uuid/power`, `POST .../command`, `GET .../console` (SSE),
`GET .../stats`, `GET|PUT|DELETE .../files`, `GET|POST .../backups`, subusers, etc.

## License

MIT — see [LICENSE](LICENSE).
