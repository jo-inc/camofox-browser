#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build and manage camofox-browser on Windows (PowerShell alternative to Makefile).

.DESCRIPTION
    Provides the same targets as the Makefile for Windows users without make:
      build   - Download Camoufox + yt-dlp, then build the Docker image.
      up      - Build (if needed) and run the container.
      down    - Stop and remove the container.
      reset   - Full rebuild from scratch.
      clean   - Remove downloaded binaries.
      fetch   - Download Camoufox + yt-dlp binaries only.

.PARAMETER Target
    The action to perform: build, up, down, reset, clean, fetch (default: build).

.PARAMETER Arch
    Target architecture: x86_64 or aarch64 (default: x86_64).

.PARAMETER Channel
    Camoufox release channel: beta (stable) or alpha (latest, e.g. v150).
    The exact version/release is resolved at fetch time from the GitHub
    releases API by scripts/resolve-camoufox.js (default: beta).

.PARAMETER ContainerName
    Docker container name (default: camofox-browser).

.PARAMETER HostPort
    Host port to map (default: 9377).

.EXAMPLE
    .\build.ps1 up          # Build + run
    .\build.ps1 down        # Stop container
    .\build.ps1 fetch       # Download binaries only
#>

param(
    [ValidateSet('build', 'up', 'down', 'reset', 'clean', 'fetch')]
    [string]$Target = 'build',

    [ValidateSet('x86_64', 'aarch64')]
    [string]$Arch = 'x86_64',

    [ValidateSet('beta', 'alpha')]
    [string]$Channel = 'beta',

    [string]$ContainerName = 'camofox-browser',
    [int]$HostPort = 9377
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSCommandPath
$DistDir = Join-Path $ProjectRoot 'dist'

# If -Channel wasn't passed explicitly, allow a `CHANNEL=` line in .env to set it.
if (-not $PSBoundParameters.ContainsKey('Channel')) {
    $envFile = Join-Path $ProjectRoot '.env'
    if (Test-Path $envFile) {
        $match = Select-String -Path $envFile -Pattern '^CHANNEL=(.+)$' | Select-Object -Last 1
        if ($match) { $Channel = $match.Matches[0].Groups[1].Value.Trim() }
    }
}

# Artifacts namespaced by channel so switching channels never reuses the wrong cache.
$CamoufoxZip = Join-Path $DistDir "camoufox-$Channel-$Arch.zip"
$YtDlpBin = Join-Path $DistDir "yt-dlp-$Arch"
$ImageTag = "camofox-browser:$Channel-$Arch"
$ContainerPort = 9377

# Map architecture to upstream release filenames
if ($Arch -eq 'aarch64') {
    $CamoufoxArch = 'arm64'
    $YtDlpSuffix = '_aarch64'
} else {
    $CamoufoxArch = 'x86_64'
    $YtDlpSuffix = ''
}

$YtDlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux$YtDlpSuffix"

# Resolve the latest Camoufox release for this channel + arch. Populates the
# script-scoped $CamoufoxVersion / $CamoufoxRelease / $CamoufoxDeclaredRelease /
# $CamoufoxUrl used by fetch + build. Network call (GitHub API).
function Resolve-Camoufox {
    Write-Step "Resolving latest Camoufox ($Channel, $CamoufoxArch)..."
    $resolverPath = Join-Path $ProjectRoot 'scripts/resolve-camoufox.js'
    $json = node $resolverPath --channel $Channel --arch $CamoufoxArch --json
    if ($LASTEXITCODE -ne 0) { throw "resolve-camoufox.js failed" }
    $info = $json | ConvertFrom-Json
    $script:CamoufoxVersion = $info.version
    $script:CamoufoxRelease = $info.release
    $script:CamoufoxDeclaredRelease = $info.declaredRelease
    $script:CamoufoxUrl = $info.url
    Write-Host "  Resolved $($info.version)-$($info.release) (declared $($info.declaredRelease))"
}

function Write-Step {
    param([string]$Message)
    Write-Host ">>> $Message" -ForegroundColor Cyan
}

function Invoke-Fetch {
    Write-Step "Creating dist directory..."
    New-Item -ItemType Directory -Path $DistDir -Force | Out-Null

    # Resolve version/release/url for this channel + arch (sets script vars).
    Resolve-Camoufox

    if (-not (Test-Path $CamoufoxZip)) {
        Write-Step "Downloading Camoufox browser ($CamoufoxArch)..."
        Write-Host "  URL: $CamoufoxUrl"
        curl.exe -L -o $CamoufoxZip $CamoufoxUrl
        Write-Host "  Downloaded: $(Get-Item $CamoufoxZip | Select-Object -ExpandProperty Length) bytes"
    } else {
        Write-Host "  [SKIP] Camoufox already downloaded"
    }

    if (-not (Test-Path $YtDlpBin)) {
        Write-Step "Downloading yt-dlp ($Arch)..."
        Write-Host "  URL: $YtDlpUrl"
        curl.exe -L -o $YtDlpBin $YtDlpUrl
        Write-Host "  Downloaded: $(Get-Item $YtDlpBin | Select-Object -ExpandProperty Length) bytes"
    } else {
        Write-Host "  [SKIP] yt-dlp already downloaded"
    }
}

function Invoke-Build {
    Invoke-Fetch

    Write-Step "Building Docker image: $ImageTag"
    docker build `
        --build-arg "ARCH=$Arch" `
        --build-arg "CHANNEL=$Channel" `
        --build-arg "CAMOUFOX_VERSION=$CamoufoxVersion" `
        --build-arg "CAMOUFOX_RELEASE=$CamoufoxRelease" `
        --build-arg "CAMOUFOX_DECLARED_RELEASE=$CamoufoxDeclaredRelease" `
        -t $ImageTag `
        -f (Join-Path $ProjectRoot 'Dockerfile') `
        $ProjectRoot
}

function Invoke-Up {
    # Check if image exists
    $imageExists = docker images -q $ImageTag 2>$null
    if (-not $imageExists) {
        Write-Step "Image not found — building first..."
        Invoke-Build
    }

    # Stop & remove existing container
    docker stop $ContainerName 2>$null | Out-Null
    docker rm $ContainerName 2>$null | Out-Null

    Write-Step "Starting container: $ContainerName on port $HostPort"
    docker run -d `
        --restart unless-stopped `
        --name $ContainerName `
        -p "${HostPort}:${ContainerPort}" `
        $ImageTag

    Write-Host "Container started. Server should be available at http://localhost:$HostPort" -ForegroundColor Green
    Write-Host "Check logs: docker logs $ContainerName" -ForegroundColor Gray
}

function Invoke-Down {
    Write-Step "Stopping container: $ContainerName"
    docker stop $ContainerName 2>$null
    docker rm $ContainerName 2>$null
    Write-Host "Container stopped and removed." -ForegroundColor Green
}

function Invoke-Reset {
    Invoke-Down

    Write-Step "Removing Docker image: $ImageTag"
    docker rmi $ImageTag 2>$null

    Invoke-Build
    Invoke-Up
}

function Invoke-Clean {
    Write-Step "Removing dist directory..."
    if (Test-Path $DistDir) {
        Remove-Item -Recurse -Force $DistDir
        Write-Host "Removed: $DistDir" -ForegroundColor Green
    } else {
        Write-Host "Nothing to clean." -ForegroundColor Yellow
    }
}

# --- Main dispatch ---
switch ($Target) {
    'build'  { Invoke-Build }
    'up'     { Invoke-Up }
    'down'   { Invoke-Down }
    'reset'  { Invoke-Reset }
    'clean'  { Invoke-Clean }
    'fetch'  { Invoke-Fetch }
}
