# Nexa Inventory

Pharmacy inventory built on [InvenTree](https://github.com/inventree/InvenTree)
with one custom plugin (`nexa_inventory_plugin`) and a Nexa UI layer in the
frontend. One deployment = one pharmacy business; each branch is a top-level
stock location.

Roadmap and decisions: [`docs/nexa/ROADMAP.md`](docs/nexa/ROADMAP.md)

## Layout

| Path | What it is |
|---|---|
| `inventree-src/` | InvenTree source (tracked, not a submodule) |
| `inventree-src/nexa_inventory_plugin/` | Plugin: sale-type movements, B2B invoices, payments, receivables, reports (API prefix `/plugin/nexainventory/`) |
| `inventree-src/src/frontend/src/{pages,tables,components}/nexa/` | Nexa UI (dashboard, sales, invoices, reports) |
| `docker-compose.prod.yml`, `.github/workflows/deploy.yml` | Production deploy (Traefik + GHCR) |

## Local development

Database: a Supabase-hosted Postgres project dedicated to Nexa. Use the
**session pooler / direct connection (port 5432)**, not the transaction pooler
(6543) - Django tests need to create a temporary database.

```bash
cd inventree-src
python3.12 -m venv .venv && source .venv/bin/activate
pip install invoke
invoke install
pip install -e nexa_inventory_plugin

# copy the variables from ../.env.example into inventree-src/.env
# (gitignored) and fill in the Supabase connection + local data paths
set -a; source .env; set +a

invoke update                                  # migrate, build frontend, collect static
python3 src/backend/InvenTree/manage.py runserver 0.0.0.0:8000
invoke worker                                  # separate terminal
```

Run the plugin tests:

```bash
python3 src/backend/InvenTree/manage.py test nexa_inventory -v 2
```

## Deployment

CI builds `inventree-src/Dockerfile.prod` into `ghcr.io/<GITHUB_OWNER>/pharmacy-inventory`
and deploys over SSH. Before the first deploy, replace the placeholders
`<GITHUB_OWNER>`, `<NEXA_HOST>`, `<VPS_PATH>`, `<SUPABASE_REF>` and
`<SUPABASE_POOLER_HOST>` in `docker-compose.prod.yml`, `.github/workflows/deploy.yml`
and `.env.example`, and add `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` secrets to the
GitHub repo. Runtime secrets live in `.env.local` on the VPS and are never committed.

`docker-compose.yml` is the stock InvenTree recipe and does not include the
plugin; only `Dockerfile.prod` bakes it in.
