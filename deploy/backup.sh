#!/bin/sh
# Nightly backup of Ishonch: a PostgreSQL dump and a copy of the photo bucket, kept for KEEP_DAYS.
# Run from the project directory (where docker-compose.yml and .env are), e.g. from root's crontab:
#   15 3 * * * cd /opt/ishonch && ./deploy/backup.sh >> logs/backup.log 2>&1
# Copy BACKUP_DIR off the server as well (another disk or provider): a backup on the same disk is not one.
# Restore: see README → «Бэкапы».
set -eu
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y-%m-%d_%H%M)"
mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/photos"

docker compose exec -T postgres pg_dump -U ishonch -Fc ishonch > "$BACKUP_DIR/db/ishonch_$STAMP.dump"
# Photos: an incremental mirror of the bucket into BACKUP_DIR/photos.
set -a; . ./.env; set +a
docker run --rm --network "$(basename "$PWD")_default" -v "$(realpath "$BACKUP_DIR")/photos:/backup" \
  -e MC_HOST_local="http://${MINIO_ROOT_USER:-ishonch}:${MINIO_ROOT_PASSWORD:-ishonch-secret}@minio:9000" \
  "${MINIO_MC_IMAGE:-minio/mc:latest}" mirror --overwrite "local/${MINIO_BUCKET:-ishonch-photos}" /backup

find "$BACKUP_DIR/db" -name 'ishonch_*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: $BACKUP_DIR/db/ishonch_$STAMP.dump"
