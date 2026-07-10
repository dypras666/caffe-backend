#!/bin/bash
# Update Caddyfile with tenant routing
# Usage: ./update-caddy.sh <tenant_name>

TENANT=$1
SERVER="root@46.8.226.36"
SSH_PASS="h8I8odYa5fzi"
BASE_DIR="/opt/cafe-azzura/tenants"

if [ -z "$TENANT" ]; then
    echo "Usage: $0 <tenant_name>"
    exit 1
fi

# Get ports from server
PORTS=$(sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no "$SERVER" "grep ^${TENANT}: ${BASE_DIR}/.port_map 2>/dev/null" || echo "")

if [ -z "$PORTS" ]; then
    echo "Tenant $TENANT not found. Run deploy.sh first."
    exit 1
fi

BACKEND_PORT=$(echo $PORTS | grep -oP 'backend=\K[0-9]+')
ADMIN_PORT=$(echo $PORTS | grep -oP 'admin=\K[0-9]+')
UI_PORT=$(echo $PORTS | grep -oP 'ui=\K[0-9]+')

echo "Updating Caddyfile for $TENANT..."
echo "  Backend: $BACKEND_PORT"
echo "  Admin: $ADMIN_PORT"
echo "  UI: $UI_PORT"

sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no "$SERVER" bash << CFGY
TENANT=${TENANT}
BACKEND_PORT=${BACKEND_PORT}
ADMIN_PORT=${ADMIN_PORT}
UI_PORT=${UI_PORT}
BASE_DIR=${BASE_DIR}

# Remove old block if exists
sed -i "/# Tenant: \${TENANT}/,/}$/{ /# Tenant: \${TENANT}/!{ /}/!d }; }" /etc/caddy/Caddyfile

# Add new block at end
cat >> /etc/caddy/Caddyfile << EOF
# Tenant: \${TENANT}
\${TENANT}.caffe.my.id {
    reverse_proxy /\${TENANT}/api/* localhost:\${BACKEND_PORT}
    reverse_proxy /\${TENANT}/admin/* localhost:\${ADMIN_PORT}
    reverse_proxy /* localhost:\${UI_PORT}
}
EOF

# Reload Caddy
caddy reload --config /etc/caddy/Caddyfile
echo "Caddy updated for \${TENANT}.caffe.my.id"
CFGY

echo ""
echo "=== Caddy configured ==="
echo "$TENANT.caffe.my.id -> api:${BACKEND_PORT}, admin:${ADMIN_PORT}, ui:${UI_PORT}"
