#!/usr/bin/env bash
# Per-boot: mock OpenLive gateway on :8787. Idempotent; returns after /health is OK.
set -euo pipefail

mkdir -p /tmp/openlive
if curl -sf --max-time 2 http://127.0.0.1:8787/health >/dev/null; then
  echo openlive-gateway already healthy
  exit 0
fi
if [ ! -x ./target/debug/openlive-gateway ]; then
  echo missing ./target/debug/openlive-gateway >&2
  exit 1
fi
setsid ./target/debug/openlive-gateway \
  --listen 0.0.0.0:8787 \
  --provider mock \
  --web-dir apps/openlive-gateway/web \
  </dev/null >/tmp/openlive/gateway.log 2>&1 &
echo $! >/tmp/openlive/gateway.pid
for _ in $(seq 1 60); do
  if curl -sf --max-time 2 http://127.0.0.1:8787/health >/dev/null; then
    echo openlive-gateway ready
    exit 0
  fi
  sleep 0.25
done
echo gateway failed to become healthy >&2
cat /tmp/openlive/gateway.log >&2 || true
exit 1
