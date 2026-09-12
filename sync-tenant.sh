#!/bin/bash
# sync-tenant.sh — sync cafe-backend ke satu atau semua tenant di VPS
#
# Usage:
#   ./sync-tenant.sh soto-pak-budi          # sync + migrate satu tenant
#   ./sync-tenant.sh --all                  # sync + migrate semua tenant
#   ./sync-tenant.sh soto-pak-budi --no-migrate   # sync saja, skip migrate
#   ./sync-tenant.sh --migrate-only soto    # migrate saja (tanpa upload)
#
# Set SSH_PASS, SERVER, BASE_DIR di env atau .env.deploy jika perlu override.

set -e

SERVER="${SERVER:-root@46.8.226.36}"
SSH_PASS="${SSH_PASS:-h8I8odYa5fzi}"
BASE_DIR="${BASE_DIR:-/opt/cafe-azzura/tenants}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SSH="sshpass -p $SSH_PASS ssh -o StrictHostKeyChecking=no $SERVER"
SCP="sshpass -p $SSH_PASS scp -o StrictHostKeyChecking=no"

# ── Parse args ────────────────────────────────────────────────
TENANT=""
ALL=false
MIGRATE=true
MIGRATE_ONLY=false

for arg in "$@"; do
  case $arg in
    --all)           ALL=true ;;
    --no-migrate)    MIGRATE=false ;;
    --migrate-only)  MIGRATE_ONLY=true ;;
    --*)             echo "Unknown flag: $arg"; exit 1 ;;
    *)               TENANT=$arg ;;
  esac
done

if [ -z "$TENANT" ] && [ "$ALL" = false ]; then
  echo "Usage: $0 <tenant-slug> [--no-migrate]"
  echo "       $0 --all [--no-migrate]"
  echo "       $0 <tenant-slug> --migrate-only"
  exit 1
fi

# ── File list to sync ─────────────────────────────────────────
FILES=(
  server.js
  package.json
)

# Sync all JS files from essential directories (recursive)
for d in config middleware database routes controllers services utils; do
  if [ -d "$d" ]; then
    while IFS= read -r f; do
      FILES+=("$f")
    done < <(find "$d" -type f -name "*.js")
  fi
done

do_sync() {
  local slug=$1
  local dir="${BASE_DIR}/${slug}/backend"

  echo ""
  echo "▶ Syncing ${slug}..."

  if [ "$MIGRATE_ONLY" = true ]; then
    echo "  (skipping file sync — migrate only)"
  else
    # Sync files using tar to avoid SSH rate limits
    echo "  📦 Packing files..."
    tar -czf /tmp/cafe-backend-sync.tar.gz -T <(printf "%s\n" "${FILES[@]}")
    $SCP /tmp/cafe-backend-sync.tar.gz "${SERVER}:/tmp/cafe-backend-sync-${slug}.tar.gz" 2>/dev/null
    $SSH "mkdir -p ${dir} && tar -xzf /tmp/cafe-backend-sync-${slug}.tar.gz -C ${dir}"
    echo "  ✓ All files synced"
  fi


  # Sync package.json then install any missing packages
  $SCP "${SCRIPT_DIR}/package.json" "${SERVER}:${dir}/package.json" 2>/dev/null || true
  echo "  📦 Installing dependencies..."
  $SSH "cd ${dir} && npm install --production --silent 2>/dev/null" && \
    echo "  ✅ npm install done" || echo "  ⚠ npm install had warnings"

  if [ "$MIGRATE" = true ]; then
    echo "  ⟳ Running migrations..."
    $SSH "cd ${dir} && node database/migrate.js" && \
      echo "  ✅ Migration done" || echo "  ❌ Migration failed"
  fi

  echo "  ↻ Restarting service cafe-tenant-${slug}.service..."
  $SSH "systemctl restart cafe-tenant-${slug}.service" && \
    echo "  ✅ Service restarted" || echo "  ❌ Failed to restart service"
}

do_sync_all() {
  # Get all tenant slugs from server
  SLUGS=$($SSH "ls ${BASE_DIR}/" 2>/dev/null)
  if [ -z "$SLUGS" ]; then
    echo "Tidak ada tenant di ${BASE_DIR}"
    exit 1
  fi
  for slug in $SLUGS; do
    do_sync "$slug"
  done
}

# ── Main ──────────────────────────────────────────────────────
echo "=== cafe-backend sync $(date '+%Y-%m-%d %H:%M') ==="

if [ "$ALL" = true ]; then
  do_sync_all
else
  do_sync "$TENANT"
fi

echo ""
echo "=== Done ==="
