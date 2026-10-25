# Extract the pinned C&C Gold downloads into the site's local data directory.
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'prepare-data.ts')
if ($LASTEXITCODE -ne 0) { throw "Data extraction failed with exit code $LASTEXITCODE" }
