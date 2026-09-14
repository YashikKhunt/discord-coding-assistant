#!/usr/bin/env bash
# Nightly database backup. Keeps 7 days locally and, when BACKUP_PAR_URL is set,
# uploads a copy to Oracle Object Storage through a pre-authenticated request.
set -euo pipefail

cd "$(dirname "$0")/../.."
BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/dca-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"
set -a; [[ -f .env ]] && . ./.env; set +a

docker compose -f infra/compose.prod.yml --env-file .env exec -T postgres \
  pg_dump -U dca -d dca --no-owner | gzip -9 > "$FILE"

SIZE="$(du -h "$FILE" | cut -f1)"
echo "$(date -u +%FT%TZ) backup written: $FILE ($SIZE)"

if [[ -n "${BACKUP_PAR_URL:-}" ]]; then
  # A pre-authenticated request URL ends with "/o/"; the object name is appended.
  if curl -fsS -X PUT --data-binary "@$FILE" "${BACKUP_PAR_URL%/}/$(basename "$FILE")" >/dev/null; then
    echo "$(date -u +%FT%TZ) uploaded to object storage"
  else
    echo "$(date -u +%FT%TZ) WARNING: upload failed; local copy kept" >&2
  fi
fi

find "$BACKUP_DIR" -name 'dca-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) local backups: $(find "$BACKUP_DIR" -name 'dca-*.sql.gz' | wc -l | tr -d ' ')"
