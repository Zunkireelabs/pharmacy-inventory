# Deploying Nexa Inventory

Domain: `nexa-inventory.zunkireelabs.com` -> server `169.58.62.143` (DNS A record already set).

Flow: GitHub Actions builds `inventree-src/Dockerfile.prod` into
`ghcr.io/zunkireelabs/pharmacy-inventory`, SSHes to the server, pulls it and starts it
behind Traefik (automatic HTTPS). The database is the Supabase project `nexa`.

## 1. Server prerequisites (once)
- Docker + Docker Compose plugin installed.
- Traefik running with Let's Encrypt, entrypoints `web` and `websecure`, cert resolver
  named `letsencrypt`, on a Docker network named `hosting` (create it with
  `docker network create hosting` if missing). `docker-compose.prod.yml` expects exactly this.
- Ports 80 and 443 open (they are).
- The repo cloned at `/root/devprojects/nexa-inventory`
  (`git clone https://github.com/Zunkireelabs/pharmacy-inventory.git /root/devprojects/nexa-inventory`).

## 2. Runtime settings: `/root/devprojects/nexa-inventory/.env.local` (never committed)
Copy `.env.example` and fill in:
- `INVENTREE_SITE_URL=https://nexa-inventory.zunkireelabs.com`
- Supabase **Session pooler** (not the direct host - servers usually lack IPv6):
  `INVENTREE_DB_HOST=<pooler host from Supabase: Connect > Session pooler>`,
  `INVENTREE_DB_PORT=5432`, `INVENTREE_DB_USER=postgres.gipnvqfyvqozdomvqcii`,
  `INVENTREE_DB_PASSWORD=<database password>`, `INVENTREE_DB_NAME=postgres`.
- `INVENTREE_AUTO_UPDATE=True` (applies new migrations on start).
- `INVENTREE_PLUGINS_ENABLED=True` (already in the example).

## 3. GitHub secrets (repo Settings > Secrets and variables > Actions)
`VPS_HOST` (169.58.62.143), `VPS_USER` (e.g. root), `VPS_SSH_KEY` (private key that can log in).
Create an environment named `production` if the workflow asks for it.

## 4. First deploy
Actions > "Deploy to Production" > Run workflow (it is manual until you restore the
`push: branches: [main]` trigger at the top of `.github/workflows/deploy.yml`).
Then check `https://nexa-inventory.zunkireelabs.com/api/system/health/` returns 200.

## 5. After the first start
- The Supabase database already holds the plugin settings, currency (NPR), demo
  medicines and pharmacy header, because it is the same database used in development.
- Create the client accounts (owner, pharmacist) and remove the development `admin`.
- Before real use: move Supabase from Free to Pro (Free pauses after inactivity, no backups).
