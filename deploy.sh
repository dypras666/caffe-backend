#!/bin/bash
# Cafe Azzura Auto-Deploy Script
# Usage: ./deploy.sh <tenant_name>

set -e

TENANT=$1
SERVER="root@46.8.226.36"
SSH_PASS="h8I8odYa5fzi"
BASE_DIR="/opt/cafe-azzura/tenants"
TENANT_DIR="${BASE_DIR}/${TENANT}"

if [ -z "$TENANT" ]; then
    echo "Usage: $0 <tenant_name>"
    exit 1
fi

echo "=== Deploying Cafe Azzura: $TENANT ==="

# Create tenant dir
sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no "$SERVER" "mkdir -p ${TENANT_DIR}"

# Upload all projects via tar + sshpass
echo "Uploading files..."
sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no "$SERVER" "mkdir -p ${TENANT_DIR}"

cd /Users/azzura/development
for proj in cafe-backend cafe-admin cafe-ui; do
    echo "Uploading $proj..."
    tar --exclude='node_modules' --exclude='.git' --exclude='*.log' --exclude='dist' -czf - $proj/ | \
        sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no "$SERVER" "tar -xzf - -C ${TENANT_DIR}"
done

# Deploy on server
sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no "$SERVER" bash << DEPLOY
set -e
TENANT=${TENANT}
TENANT_DIR=${TENANT_DIR}
BASE_DIR=${BASE_DIR}

# Stop existing containers
echo "Stopping old containers..."
docker stop \${TENANT}-backend \${TENANT}-admin \${TENANT}-ui 2>/dev/null || true
docker rm \${TENANT}-backend \${TENANT}-admin \${TENANT}-ui 2>/dev/null || true

# Find available port base
PORT_BASE=\$(grep -E "^\${TENANT}:" \${BASE_DIR}/.port_map 2>/dev/null | cut -d: -f2 | cut -d, -f1 | cut -d= -f2)
if [ -z "\$PORT_BASE" ]; then
    PORT_BASE=3000
    while grep -q ":\${PORT_BASE}," \${BASE_DIR}/.port_map 2>/dev/null; do
        PORT_BASE=\$((PORT_BASE + 10))
    done
fi

BACKEND_PORT=\$PORT_BASE
ADMIN_PORT=\$((PORT_BASE + 1))
UI_PORT=\$((PORT_BASE + 2))

echo "Ports: backend=\${BACKEND_PORT}, admin=\${ADMIN_PORT}, ui=\${UI_PORT}"

# Build images
echo "Building backend..."
docker build -t \${TENANT}-backend:latest \${TENANT_DIR}/backend/

echo "Building admin..."
docker build -t \${TENANT}-admin:latest \${TENANT_DIR}/admin/

echo "Building ui..."
docker build -t \${TENANT}-ui:latest \${TENANT_DIR}/ui/

# Run containers
echo "Starting containers..."
docker run -d --name \${TENANT}-backend --restart unless-stopped -p \${BACKEND_PORT}:3000 \${TENANT}-backend:latest
docker run -d --name \${TENANT}-admin --restart unless-stopped -p \${ADMIN_PORT}:80 \${TENANT}-admin:latest
docker run -d --name \${TENANT}-ui --restart unless-stopped -p \${UI_PORT}:80 \${TENANT}-ui:latest

# Save port mapping
grep -v "^\${TENANT}:" \${BASE_DIR}/.port_map > \${BASE_DIR}/.port_map.tmp 2>/dev/null || true
echo "\${TENANT}:backend=\${BACKEND_PORT},admin=\${ADMIN_PORT},ui=\${UI_PORT}" >> \${BASE_DIR}/.port_map.tmp
mv \${BASE_DIR}/.port_map.tmp \${BASE_DIR}/.port_map

echo "Done! \${TENANT}.caffe.my.id -> backend:\${BACKEND_PORT}, admin:\${ADMIN_PORT}, ui:\${UI_PORT}"
docker ps --filter "name=\${TENANT}" --format "table {{.Names}}\t{{.Ports}}"
DEPLOY

echo ""
echo "=== $TENANT deployed ==="
echo "Run: ./update-caddy.sh $TENANT"
