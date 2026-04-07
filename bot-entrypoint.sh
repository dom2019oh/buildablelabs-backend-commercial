#!/bin/sh
# =============================================================================
# Buildable Labs — Bot Container Entrypoint
# Runs inside each Discord bot container on the Oracle VPS.
# =============================================================================

set -e

# Install any bot-specific packages on top of the pre-installed base.
# The requirements.txt was uploaded by the deploy pipeline to /app.
if [ -f /app/requirements.txt ]; then
    echo "[Buildable] Installing bot requirements..."
    pip install --no-cache-dir -q -r /app/requirements.txt
fi

echo "[Buildable] Starting bot..."

# exec replaces this shell — SIGTERM goes directly to python (clean shutdown)
exec python /app/main.py
