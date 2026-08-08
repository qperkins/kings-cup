# Deployment Guide — Oracle Cloud (Always Free ARM)

Deploy the King's Cup game engine backend to Oracle Cloud's Always Free tier
(2 OCPU / 12 GB RAM max; provision **1 OCPU / 6 GB** to leave headroom).

## Architecture

Production uses a simplified stack (`docker-compose.prod.yml`):

- Single Redis instance (AOF persistence)
- Single FastAPI app instance
- Nginx reverse proxy with SSL termination

Development uses the full Sentinel stack in `docker-compose.yml`.

## Prerequisites

1. Oracle Cloud account with an Ampere A1 instance (1 OCPU, 6 GB RAM)
2. Domain name with DNS A record pointing to the instance public IP
3. GitHub repository secrets:
   - `ORACLE_HOST` — instance public IP or hostname
   - `ORACLE_USER` — SSH user (e.g. `ubuntu`)
   - `ORACLE_SSH_KEY` — private SSH key for deploy access

## One-Time Instance Setup

SSH into the instance and run:

```bash
sudo bash scripts/setup-oracle-cloud.sh kxc.cards you@example.com
```

This script:

- Installs Docker and docker compose plugin
- Opens firewall ports 22, 80, 443
- Clones the repo to `/opt/kings-cup-backend`
- Replaces SSL certificate paths in `nginx/nginx.prod.conf` for `kxc.cards`
- Obtains a Let's Encrypt certificate via certbot standalone
- Verifies certbot auto-renewal is enabled (systemd timer or cron)
- Starts the production stack

### Verify SSL renewal

```bash
certbot certificates   # shows expiry date for each cert
systemctl list-timers | grep certbot   # confirms auto-renewal timer
```

Certbot's installer usually enables a systemd timer automatically. If neither
a timer nor `/etc/cron.d/certbot` is present, the setup script attempts to
enable `certbot.timer`.

## GHCR Package Visibility (Required After First CI Push)

GHCR packages default to **private** on first push, even from a public GitHub
repo. The Oracle instance pulls from a **public** package with no authentication.

After the first successful CI push to `main`:

1. Go to GitHub → **Packages** → `kings-cup-backend`
2. **Package settings** → **Change visibility** → **Public**

If you skip this step, the first deploy will fail with an auth/unauthorized error
on `docker pull`. This is expected — not a mystery bug.

Image location: `ghcr.io/qperkins/kings-cup-backend:latest`

## CI/CD Workflows

### Test (`.github/workflows/test.yml`)

Runs on every push and pull request:

- Spins up Redis as a GitHub Actions service
- Runs `pytest tests/ -v`
- Failover stack tests that require `ws://localhost:8080` skip automatically

### Deploy (`.github/workflows/deploy.yml`)

Runs on push to `main`:

1. Builds ARM64 image: `docker buildx build --platform linux/arm64`
2. Pushes to `ghcr.io/<org>/kings-cup-backend:latest`
3. SSHs to Oracle instance and runs `scripts/deploy.sh`

The deploy script **only pulls from GHCR** — it never builds locally. Pull
failures exit immediately with an error.

### E2E (`.github/workflows/e2e.yml`)

Manual trigger via **Actions → E2E Tests → Run workflow**:

- Provide `ws_base` (e.g. `wss://kxc.cards`)
- Optionally provide `health_url` (e.g. `https://kxc.cards/health`)

Runs WebSocket smoke tests against production.

## Manual Deploy

On the Oracle instance:

```bash
cd /opt/kings-cup-backend
./scripts/deploy.sh
```

Override the image if needed:

```bash
IMAGE=ghcr.io/qperkins/kings-cup-backend:latest ./scripts/deploy.sh
```

## Environment Variables

Copy `.env.production.example` to `.env` if running outside compose defaults:

| Variable | Description |
|---|---|
| `REDIS_DIRECT_URL` | Direct Redis URL (bypasses Sentinel). Set to `redis://redis:6379` in prod. |
| `LOG_LEVEL` | Logging level (default: `info`) |

When `REDIS_DIRECT_URL` is unset, the app uses Sentinel mode (development).

## Observability

- Structured logs: WideEvent JSON lines from the app
- Container logs: `docker compose -f docker-compose.prod.yml logs -f`
- Health endpoint: `GET /health` (returns Redis connectivity status)

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `docker pull` unauthorized | GHCR package still private | Make package public (see above) |
| Health check fails after deploy | Redis not ready, bad image | `docker compose -f docker-compose.prod.yml logs app` |
| SSL errors in browser | Cert not issued or wrong domain in nginx config | `certbot certificates`, check `nginx/nginx.prod.conf` paths |
| WebSocket disconnects | Nginx proxy timeout | Already set to 3600s in `nginx.prod.conf` |

## Local Production Stack Test

```bash
export REDIS_DIRECT_URL=redis://localhost:6379
docker compose -f docker-compose.prod.yml up --build
```

Note: local `--build` is for development only. Production deploys always pull
pre-built ARM images from GHCR.
