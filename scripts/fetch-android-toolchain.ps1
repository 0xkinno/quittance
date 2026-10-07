# Install the Android build toolchain without winget or an IDE.
#
# `winget` on this machine reports "the file cannot be accessed by the system"
# — a broken App Installer alias that needs a Store repair with administrator
# rights. Everything here is a plain archive extracted into a user-writable
# directory, so none of it needs elevation.
#
#   Temurin JDK 17   -> C:\Android\jdk-17
#   cmdline-tools    -> C:\Android\cmdline-tools\latest
#
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-android-toolchain.ps1

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = 'C:\Android'
$null = New-Item -ItemType Directory -Force -Path $root

function Get-WithResume {
  param([string]$Url, [string]$Out, [string]$Label)

  if (Test-Path $Out) {
    "{0}: already downloaded ({1:N1} MB)" -f $Label, ((Get-Item $Out).Length / 1MB)
    return
  }
  "${Label}: downloading..."
  # curl resumes across the dropped connections this network produces on large
  # transfers; Invoke-WebRequest restarts from zero instead.
  & curl.exe -sS -L -C - --retry 10 --retry-delay 3 --speed-time 30 --speed-limit 1024 -o $Out $Url
  "{0}: {1:N1} MB" -f $Label, ((Get-Item $Out).Length / 1MB)
}

# --- JDK 17 ----------------------------------------------------------------
#
# Temurin, as the build instruction specifies. The zip rather than the msi so
# no installer and no elevation is involved.

$jdkZip = Join-Path $env:TEMP 'temurin17.zip'
Get-WithResume `
  -Url 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk' `
  -Out $jdkZip -Label 'Temurin JDK 17'

if (-not (Test-Path "$root\jdk-17\bin\java.exe")) {
  "extracting JDK..."
  $staging = Join-Path $env:TEMP 'jdk-staging'
  if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
  Expand-Archive -Path $jdkZip -DestinationPath $staging -Force
  # The archive contains a single versioned top-level directory; normalising
  # the name keeps JAVA_HOME stable across JDK patch releases.
  $inner = Get-ChildItem $staging -Directory | Select-Object -First 1
  if (Test-Path "$root\jdk-17") { Remove-Item "$root\jdk-17" -Recurse -Force }
  Move-Item $inner.FullName "$root\jdk-17"
  Remove-Item $staging -Recurse -Force
}
"JDK: $root\jdk-17"

# --- Android command-line tools --------------------------------------------

$cltZip = Join-Path $env:TEMP 'cmdline-tools.zip'
Get-WithResume `
  -Url 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' `
  -Out $cltZip -Label 'cmdline-tools'

if (-not (Test-Path "$root\cmdline-tools\latest\bin\sdkmanager.bat")) {
  "extracting cmdline-tools..."
  $staging = Join-Path $env:TEMP 'clt-staging'
  if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
  Expand-Archive -Path $cltZip -DestinationPath $staging -Force
  # sdkmanager insists on living at cmdline-tools/latest/ and refuses to run
  # from the path the archive unpacks to.
  $null = New-Item -ItemType Directory -Force -Path "$root\cmdline-tools"
  if (Test-Path "$root\cmdline-tools\latest") { Remove-Item "$root\cmdline-tools\latest" -Recurse -Force }
  Move-Item "$staging\cmdline-tools" "$root\cmdline-tools\latest"
  Remove-Item $staging -Recurse -Force
}
"cmdline-tools: $root\cmdline-tools\latest"

# --- Environment -----------------------------------------------------------

[Environment]::SetEnvironmentVariable('JAVA_HOME', "$root\jdk-17", 'User')
[Environment]::SetEnvironmentVariable('ANDROID_HOME', $root, 'User')
[Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT', $root, 'User')

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
foreach ($p in @("$root\jdk-17\bin", "$root\platform-tools", "$root\cmdline-tools\latest\bin")) {
  if ($userPath -notlike "*$p*") { $userPath = "$userPath;$p" }
}
[Environment]::SetEnvironmentVariable('Path', $userPath, 'User')

"JAVA_HOME, ANDROID_HOME and PATH set for the user."
& "$root\jdk-17\bin\java.exe" -version 2>&1 | Select-Object -First 1
