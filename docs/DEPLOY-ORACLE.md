# Deploying to Oracle Cloud (Always Free)

Runs the whole stack 24/7 on one Ampere A1 instance: **2 cores, 12 GB RAM, 200 GB disk, $0/month**.
Everything below assumes Ubuntu 24.04 on ARM.

| Piece | Where it runs |
|---|---|
| caddy (HTTPS), api + dashboard, bot, worker, postgres, egress-proxy | Docker Compose on the instance |
| sandboxes (one per job) | Created by the worker, isolated with gVisor |
| nightly backup | cron on the instance → local disk + Object Storage |

---

## 1. Create the instance

1. Sign up at <https://signup.oraclecloud.com>. **The home region cannot be changed later** and
   free instances only exist there, so pick a nearby, less crowded region.
2. Create an SSH key on your machine:
   ```bash
   ssh-keygen -t ed25519 -C "oracle-dca" -f ~/.ssh/oracle_dca
   ```
3. **Compute → Instances → Create instance**
   - Image: **Ubuntu 24.04**
   - Shape: **Ampere → VM.Standard.A1.Flex → 2 OCPUs, 12 GB**
   - Boot volume: **150 GB**
   - Paste `~/.ssh/oracle_dca.pub` as the SSH key
   - Keep the public IPv4 address
4. "Out of capacity" is common on free Ampere: try another availability domain or retry later.

### Open the ports

**Networking → Virtual Cloud Networks → your VCN → Security Lists → Default** → add two
ingress rules: source `0.0.0.0/0`, protocol TCP, destination ports **80** and **443**.

The setup script opens the same ports in the instance's own firewall, which Oracle's images
block by default.

---

## 2. Run the setup script

```bash
ssh -i ~/.ssh/oracle_dca ubuntu@<PUBLIC_IP>
curl -fsSL https://raw.githubusercontent.com/YashikKhunt/discord-coding-assistant/main/infra/scripts/setup-oracle.sh | bash
exit   # log out and back in so docker works without sudo
```

It installs Docker and gVisor, adds a 2 GB swap file, opens the firewall, clones the repo to
`/opt/dca`, builds the sandbox images and schedules the nightly backup. It is safe to re-run.

If it reports that gVisor cannot start a container, set `SANDBOX_RUNTIME=runc` in `.env`.
Sandboxes then rely on plain Docker isolation instead of gVisor.

---

## 3. Point the domain at the instance

The dashboard needs HTTPS because Discord only allows secure OAuth redirects. Free options:

- **DuckDNS**: create a subdomain at <https://duckdns.org> and set its IP to the instance.
- **GitHub Student Pack**: a free `.me` (Namecheap) or `.tech` domain, with an `A` record
  pointing at the instance.

Verify before continuing (it should print your instance IP):

```bash
dig +short agent.example.com
```

---

## 4. Configure secrets

```bash
cd /opt/dca
cp .env.example .env && chmod 600 .env
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 32   # INTERNAL_API_TOKEN
openssl rand -hex 32   # SESSION_SECRET
nano .env
```

Values that differ from local development:

```ini
DOMAIN=agent.example.com
ACME_EMAIL=you@example.com
DASHBOARD_URL=https://agent.example.com
POSTGRES_PASSWORD=<generated>
SANDBOX_RUNTIME=runsc
SANDBOX_CPUS=1            # 2 cores total, 2 jobs at once
SANDBOX_MEMORY_MB=3072
WORKER_CONCURRENCY=2
```

Then add `https://agent.example.com/auth/discord/callback` to **Discord Developer Portal →
your app → OAuth2 → Redirects** (keep the localhost one for development).

---

## 5. Deploy

```bash
cd /opt/dca && ./infra/scripts/deploy.sh
```

This builds the image, starts everything, waits for the API to become healthy and registers the
slash commands. The API applies database migrations on start.

Check it:

```bash
curl -s https://agent.example.com/healthz        # {"ok":true}
docker compose -f infra/compose.prod.yml ps      # all services up
docker compose -f infra/compose.prod.yml logs -f bot worker
```

Then run `/runtest repo:owner/app` in `#create-job`.

---

## 6. Keep it alive

**Idle reclamation.** Oracle can reclaim an Always Free instance when, across 7 days, CPU (95th
percentile), network *and* memory all stay below 20%. This bot is idle most of the time. Either
upgrade the tenancy to **Pay As You Go** (still $0 within the free limits; set a $1 budget alert),
or accept the risk and rely on backups — a rebuild is the setup script plus a restore.

**Uptime alert.** Add a free monitor (e.g. UptimeRobot) on `https://agent.example.com/healthz`,
checked every 5 minutes.

**Off-instance backups.** In the console: **Storage → Buckets → Create bucket** (`dca-backups`),
then **Pre-Authenticated Requests → Create**: object *write* permission, "enable object listing"
off, expiry a year out. Put the URL in `.env`:

```ini
BACKUP_PAR_URL=https://objectstorage.<region>.oraclecloud.com/p/<token>/n/<ns>/b/dca-backups/o/
```

Backups run at 03:20 UTC, keep 7 days locally, and upload a copy. Test it now:

```bash
./infra/scripts/backup.sh && ls -lh backups/
```

---

## Updating

```bash
cd /opt/dca && ./infra/scripts/deploy.sh --pull
```

## Restoring a backup

```bash
cd /opt/dca
gunzip -c backups/dca-<stamp>.sql.gz | \
  docker compose -f infra/compose.prod.yml --env-file .env exec -T postgres psql -U dca -d dca
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Site unreachable, certificate not issued | Check both firewalls: OCI security list ingress and `sudo iptables -L INPUT -n` on the instance |
| `caddy` logs "no such host" | DNS `A` record is missing or not propagated yet |
| Jobs stay `queued` | `docker compose -f infra/compose.prod.yml logs worker`; usually Docker socket permissions or a missing sandbox image |
| Sandboxes fail to start | `docker run --rm --runtime=runsc alpine:3 true`; if it fails, set `SANDBOX_RUNTIME=runc` |
| Dependency installs fail in a sandbox | The host must reach the registries; check `docker compose logs egress-proxy`. Sandboxes get the proxy's IP as a hosts entry because Docker's embedded DNS is unreachable under gVisor; if the proxy container was recreated, restart the worker so new sandboxes pick up its address |
| Out of disk | `docker system prune -af --volumes` (keeps named volumes in use), and check `backups/` |
