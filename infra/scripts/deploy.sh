#!/usr/bin/env bash
# Builds and (re)starts the stack. Run from the application directory on the VPS.
set -euo pipefail

cd "$(dirname "$0")/../.."
COMPOSE=(docker compose -f infra/compose.prod.yml --env-file .env)

[[ -f .env ]] || { echo "Missing .env (copy .env.example and fill it in)"; exit 1; }

if [[ "${1:-}" == "--pull" ]]; then
  echo "==> Updating source"
  git pull --ff-only
fi

echo "==> Building images"
"${COMPOSE[@]}" build

echo "==> Starting services"
# The api applies database migrations on start.
"${COMPOSE[@]}" up -d --remove-orphans

echo "==> Waiting for health"
for _ in $(seq 1 30); do
  if [[ "$("${COMPOSE[@]}" ps --format json | jq -rs '[.[] | select(.Service=="api") | .Health] | first')" == "healthy" ]]; then
    break
  fi
  sleep 5
done

"${COMPOSE[@]}" ps
echo
echo "Registering slash commands"
"${COMPOSE[@]}" exec -T api node_modules/.bin/tsx apps/bot/src/register-commands.ts ||
  echo "(register failed; run it again once the bot is configured)"
echo
echo "Logs:    docker compose -f infra/compose.prod.yml logs -f bot worker"
echo "Restart: docker compose -f infra/compose.prod.yml --env-file .env restart worker"
