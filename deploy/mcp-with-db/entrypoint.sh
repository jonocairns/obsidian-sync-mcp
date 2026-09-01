#!/bin/sh
set -e

# Run CouchDB's own setup script, then start CouchDB in background
/docker-entrypoint.sh /opt/couchdb/bin/couchdb &
COUCH_PID=$!

# Wait for CouchDB to be ready
echo "Waiting for CouchDB..."
COUCH_READY=false
for _attempt in $(seq 1 30); do
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:5984/ 2>/dev/null | grep -qE "^[2-4]"; then
        echo "CouchDB is ready."
        COUCH_READY=true
        break
    fi
    sleep 1
done
if [ "$COUCH_READY" != "true" ]; then
    echo "ERROR: CouchDB did not become ready within 30 seconds."
    exit 1
fi

# Admin credentials
DB=${COUCHDB_DATABASE:-obsidian}
# The dollar sign below is a literal allowed CouchDB database character.
# shellcheck disable=SC2016
if ! printf '%s' "$DB" | grep -qE '^[a-z][a-z0-9_$()+-]*$'; then
    echo "ERROR: COUCHDB_DATABASE contains invalid characters: $DB"
    exit 1
fi
ADMIN_USER=${COUCHDB_USER:-admin}
ADMIN_PASS=${COUCHDB_PASSWORD}

if [ -z "$ADMIN_PASS" ]; then
    echo "ERROR: COUCHDB_PASSWORD must be set."
    exit 1
fi

# Create database if it doesn't exist
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -u "$ADMIN_USER:$ADMIN_PASS" "http://localhost:5984/$DB")
if [ "$HTTP_CODE" = "404" ]; then
    echo "Creating database: $DB"
    curl --fail --silent --show-error -u "$ADMIN_USER:$ADMIN_PASS" -X PUT "http://localhost:5984/$DB" >/dev/null
elif [ "$HTTP_CODE" = "200" ]; then
    echo "Database $DB already exists."
else
    echo "ERROR: CouchDB returned HTTP $HTTP_CODE while checking database $DB."
    exit 1
fi

# Optional: create a non-admin LiveSync user
LIVESYNC_USER=${LIVESYNC_USER:-}
LIVESYNC_PASS=${LIVESYNC_PASSWORD:-}

if { [ -n "$LIVESYNC_USER" ] && [ -z "$LIVESYNC_PASS" ]; } || \
   { [ -z "$LIVESYNC_USER" ] && [ -n "$LIVESYNC_PASS" ]; }; then
    echo "ERROR: LIVESYNC_USER and LIVESYNC_PASSWORD must be set together."
    exit 1
fi

if [ -n "$LIVESYNC_USER" ] && ! printf '%s' "$LIVESYNC_USER" | grep -qE '^[A-Za-z0-9._-]+$'; then
    echo "ERROR: LIVESYNC_USER must contain only letters, numbers, dots, underscores, or hyphens."
    exit 1
fi

if [ -n "$LIVESYNC_USER" ] && [ -n "$LIVESYNC_PASS" ]; then
    # Reject control characters in credentials (prevents JSON injection)
    if printf '%s%s' "$LIVESYNC_USER" "$LIVESYNC_PASS" | grep -qP '[\x00-\x1f]'; then
        echo "ERROR: LIVESYNC_USER/PASSWORD contains control characters"
        exit 1
    fi
    echo "Setting up LiveSync user: $LIVESYNC_USER"
    curl -s -o /dev/null -u "$ADMIN_USER:$ADMIN_PASS" -X PUT "http://localhost:5984/_users" 2>/dev/null || true

    SAFE_USER=$(printf '%s' "$LIVESYNC_USER" | sed 's/\\/\\\\/g; s/"/\\"/g')
    SAFE_PASS=$(printf '%s' "$LIVESYNC_PASS" | sed 's/\\/\\\\/g; s/"/\\"/g')
    USER_DOC="{\"_id\":\"org.couchdb.user:${SAFE_USER}\",\"name\":\"${SAFE_USER}\",\"password\":\"${SAFE_PASS}\",\"roles\":[],\"type\":\"user\"}"

    RESP=$(curl -s -u "$ADMIN_USER:$ADMIN_PASS" -X PUT \
        "http://localhost:5984/_users/org.couchdb.user:${LIVESYNC_USER}" \
        -H "Content-Type: application/json" \
        -d "$USER_DOC")

    if echo "$RESP" | grep -q '"ok":true'; then
        echo "User $LIVESYNC_USER created."
    elif echo "$RESP" | grep -q '"conflict"'; then
        echo "User $LIVESYNC_USER already exists."
    fi

    SAFE_ADMIN=$(printf '%s' "$ADMIN_USER" | sed 's/\\/\\\\/g; s/"/\\"/g')
    SECURITY="{\"admins\":{\"names\":[\"${SAFE_ADMIN}\"],\"roles\":[]},\"members\":{\"names\":[\"${SAFE_USER}\"],\"roles\":[]}}"
    curl --fail --silent --show-error -o /dev/null -u "$ADMIN_USER:$ADMIN_PASS" -X PUT \
        "http://localhost:5984/$DB/_security" \
        -H "Content-Type: application/json" \
        -d "$SECURITY"
    echo "Database $DB restricted to $LIVESYNC_USER and admins."
else
    echo "No LIVESYNC_USER set — LiveSync will use admin credentials."
fi

shutdown() {
    trap - EXIT INT TERM
    if [ -n "${MCP_PID:-}" ]; then
        kill "$MCP_PID" 2>/dev/null || true
    fi
    kill "$COUCH_PID" 2>/dev/null || true
    wait "$COUCH_PID" 2>/dev/null || true
}
trap shutdown EXIT INT TERM

# Run the MCP process as the unprivileged CouchDB user while this supervisor
# remains PID 1 and forwards shutdown to both services.
export COUCHDB_URL="${COUCHDB_URL:-http://localhost:5984}"
export DATA_DIR="${DATA_DIR:-/opt/couchdb/data/.mcp}"
echo "Starting MCP server..."
setpriv --reuid=couchdb --regid=couchdb --clear-groups node /app/dist/main.js &
MCP_PID=$!
set +e
wait "$MCP_PID"
MCP_STATUS=$?
set -e
shutdown
exit "$MCP_STATUS"
