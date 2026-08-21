#!/usr/bin/env bash
#
# Issue the Raut TLS certificate the moment DNS starts resolving.
#
# raut.co.ke is delegated to rs51/rs52.rcnoc.com, which currently answer
# REFUSED — the zone was never created there. Rather than have someone poll by
# hand, this checks every 15 minutes and issues as soon as the A record points
# here, then disables its own timer.
#
# Only names that actually resolve to this host are passed to certbot: one
# unresolvable name fails the whole request, so asking for www when only the
# apex is live would throw away the run — and the attempt against a Let's
# Encrypt rate limit with it.
set -uo pipefail

LOG=/var/log/raut-autocert.log
SELF_IP=$(curl -s -m 10 https://api.ipify.org)
say() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

if [ -d /etc/letsencrypt/live/raut.co.ke ]; then
  say "certificate already present — disabling timer"
  systemctl disable --now raut-autocert.timer >/dev/null 2>&1
  exit 0
fi

ARGS=()
for name in raut.co.ke www.raut.co.ke; do
  ip=$(dig +short A "$name" @1.1.1.1 +time=5 +tries=2 2>/dev/null | tail -1)
  [ "$ip" = "$SELF_IP" ] && ARGS+=(-d "$name")
done

if [ ${#ARGS[@]} -eq 0 ]; then
  say "DNS not ready (nothing resolves to $SELF_IP yet)"
  exit 0
fi

say "DNS ready for:${ARGS[*]} — requesting certificate"
if certbot --nginx "${ARGS[@]}" --non-interactive --agree-tos \
     --keep-until-expiring --redirect >> "$LOG" 2>&1; then
  say "SUCCESS — certificate issued, disabling timer"
  systemctl reload nginx >> "$LOG" 2>&1
  systemctl disable --now raut-autocert.timer >/dev/null 2>&1
else
  say "certbot failed; will retry at the next tick"
fi
