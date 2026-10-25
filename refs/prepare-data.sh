#!/usr/bin/env bash
# Extract the pinned C&C Gold downloads into the site's local data directory.
set -euo pipefail
node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prepare-data.ts"
