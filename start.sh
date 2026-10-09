#!/bin/sh
cd "$(dirname "$0")"

# ===================== WRITE YOUR KEYS HERE (inside the quotes) =====================
export FOOTBALL_DATA_KEY=""   # free: https://www.football-data.org/client/register
export API_FOOTBALL_KEY=""    # paid (Algerian + Arab leagues), leave empty if none
export POLL_MS="60000"
# ====================================================================================

command -v node >/dev/null || { echo "Install Node.js 20 LTS from https://nodejs.org"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 14 ] || { echo "Node.js too old. Install Node.js 20 LTS"; exit 1; }
exec node server.js
