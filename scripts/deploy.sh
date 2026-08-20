#!/usr/bin/env bash
#
# Ship the committed tree to the production VPS.
#
#   scripts/deploy.sh [ssh-host]      default host: vps
#
# Deliberately deploys `git archive HEAD`, not the working tree: what runs in
# production is then always a commit you can name, and uncommitted local
# experiments cannot ride along.
#
# It does NOT seed. `db:seed` wipes and recreates every row, which on
# production means deleting real customers, orders and invoices.
set -euo pipefail

HOST="${1:-vps}"
APP=/var/www/raut
SHA="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"

if [ -n "$(git status --porcelain)" ]; then
  echo "WARNING: working tree is dirty. Deploying HEAD ($SHORT); local edits stay behind." >&2
fi

echo "→ packaging $SHORT"
TMP="$(mktemp -d)"
git archive --format=tar.gz -o "$TMP/raut.tar.gz" HEAD

echo "→ uploading to $HOST"
scp -q "$TMP/raut.tar.gz" "$HOST:/tmp/raut-deploy.tar.gz"
rm -rf "$TMP"

echo "→ building and restarting"
ssh "$HOST" "bash -s" <<REMOTE
set -euo pipefail
cd $APP
# .env is generated on the server and is not in the archive; keep it.
tar xzf /tmp/raut-deploy.tar.gz
cd $APP/platform
npm install --no-audit --no-fund >/dev/null
npx prisma generate >/dev/null
npx prisma migrate deploy 2>/dev/null || npx prisma db push --skip-generate >/dev/null
npm run build >/dev/null
chown -R raut:raut $APP
echo "$SHA" > $APP/DEPLOYED_SHA
echo "\$(date -u +%FT%TZ) $SHA" >> $APP/DEPLOY_LOG
systemctl restart raut.service
REMOTE

echo "→ verifying"
sleep 6
ssh "$HOST" 'curl -sf -m 15 -H "Host: raut.co.ke" http://127.0.0.1/api/v1/health >/dev/null' \
  && echo "✓ deployed $SHORT — health OK" \
  || { echo "✗ health check FAILED after deploy" >&2; exit 1; }
