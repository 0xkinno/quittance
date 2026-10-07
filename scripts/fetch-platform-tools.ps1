# Fetch the SBF platform-tools archive, resuming across dropped connections.
#
# `cargo-build-sbf` normally downloads this itself. Its Rust HTTP client cannot
# resolve DNS inside WSL on this machine, so the archive is fetched here and
# placed into the WSL cache by `scripts/wsl-install-sbf.sh`.
#
# The archive is ~492 MB and the connection to the GitHub release CDN drops
# partway through, so this resumes with `curl -C -` and retries until the file
# is complete rather than starting over each time.
#
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-platform-tools.ps1 -Version v1.48

param(
  [string]$Version = 'v1.48',
  [int]$MaxAttempts = 40
)

$ErrorActionPreference = 'Continue'

$cache = Join-Path $PSScriptRoot '..\.cache'
$null = New-Item -ItemType Directory -Force -Path $cache
$out = Join-Path $cache "platform-tools-$Version-linux-x86_64.tar.bz2"
$url = "https://github.com/anza-xyz/platform-tools/releases/download/$Version/platform-tools-linux-x86_64.tar.bz2"

# The published size for the linux-x86_64 archive. Used only to decide whether
# the file is complete; a short file is resumed rather than trusted.
$expected = 516000000

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
  $have = if (Test-Path $out) { (Get-Item $out).Length } else { 0 }

  if ($have -ge $expected) {
    "complete: {0:N1} MB after {1} attempt(s)" -f ($have / 1MB), ($attempt - 1)
    exit 0
  }

  "attempt {0}: have {1:N1} MB, resuming..." -f $attempt, ($have / 1MB)

  # -C -  resume at whatever is already on disk
  # -L    follow the CDN redirect
  # --speed-time / --speed-limit  give up on a stalled socket quickly so the
  #                               retry loop reconnects instead of hanging
  & curl.exe -sS -L -C - --speed-time 30 --speed-limit 1024 -o $out $url 2>$null

  Start-Sleep -Seconds 2
}

$final = if (Test-Path $out) { (Get-Item $out).Length } else { 0 }
"gave up after $MaxAttempts attempts with {0:N1} MB" -f ($final / 1MB)
exit 1
