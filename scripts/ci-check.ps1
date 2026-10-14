<#
.SYNOPSIS
    Runs the same checks as the `test` job in .github/workflows/deploy.yml.

.DESCRIPTION
    Steps, in CI order:
      1. bun install --frozen-lockfile
      2. bun run lint        (oxlint + cargo fmt --check + 3x cargo clippy)
      3. bun run typecheck
      4. bun run test        (cargo test + wasm-pack test + zed wasm build + build + integration)
      5. bun test            (TypeScript 100% coverage gate)
      6. Rust coverage gate  (only with -Coverage; CI runs this on Linux only)

    Every step runs even if an earlier one fails, so one run shows everything
    that is broken. Exit code is 0 only if all steps pass.

.PARAMETER Coverage
    Also run the cargo-tarpaulin 100% coverage gate. Temporarily rewrites the
    Rust sources with a wide rustfmt config, then restores them.

.PARAMETER SkipInstall
    Skip `bun install --frozen-lockfile`.

.PARAMETER FailFast
    Stop at the first failing step.

.PARAMETER LocalBun
    Use the installed bun even if it differs from the version CI pins in
    deploy.yml. By default a mismatch runs every step through the pinned one.

.EXAMPLE
    .\scripts\ci-check.ps1
.EXAMPLE
    .\scripts\ci-check.ps1 -SkipInstall -FailFast
#>
[CmdletBinding()]
param(
    [switch]$Coverage,
    [switch]$SkipInstall,
    [switch]$FailFast,
    [switch]$LocalBun
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$results = New-Object System.Collections.Generic.List[object]
$stopped = $false

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Action
    )

    if ($script:stopped) {
        $script:results.Add([pscustomobject]@{ Step = $Name; Result = 'SKIPPED'; Seconds = 0 })
        return
    }

    Write-Host ''
    Write-Host "==> $Name" -ForegroundColor Cyan
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $global:LASTEXITCODE = 0
    $ok = $true
    try {
        & $Action
        if ($LASTEXITCODE -ne 0) { $ok = $false }
    } catch {
        Write-Host $_ -ForegroundColor Red
        $ok = $false
    }
    $timer.Stop()

    $result = if ($ok) { 'PASS' } else { 'FAIL' }
    $color = if ($ok) { 'Green' } else { 'Red' }
    Write-Host "<== $Name : $result" -ForegroundColor $color
    $script:results.Add([pscustomobject]@{
        Step    = $Name
        Result  = $result
        Seconds = [math]::Round($timer.Elapsed.TotalSeconds, 1)
    })

    if (-not $ok -and $FailFast) { $script:stopped = $true }
}

# CI pins bun in deploy.yml; a different local bun can pass or fail differently
# (bun 1.4 rejects the `require()` in packages/vscode/test/wasmSetup.ts), so run
# every step through the pinned version when the local one does not match.
function Get-PinnedBunVersion {
    $workflow = Join-Path $repoRoot '.github\workflows\deploy.yml'
    $match = Select-String -Path $workflow -Pattern "bun-version:\s*'?([0-9.]+)'?" | Select-Object -First 1
    if ($match) { return $match.Matches[0].Groups[1].Value }
    return $null
}

function Invoke-Bun {
    if ($script:pinnedBun) {
        bun x "bun@$script:pinnedBun" @args
    } else {
        bun @args
    }
}

function Test-Prerequisites {
    $missing = @()
    foreach ($tool in 'cargo', 'rustup', 'bun') {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { $missing += $tool }
    }
    # Only `bun run test` needs wasm-pack, so lint and typecheck still run without it.
    if (-not (Get-Command 'wasm-pack' -ErrorAction SilentlyContinue)) {
        Write-Host 'wasm-pack not found: "bun run test" will fail (cargo install wasm-pack)' -ForegroundColor Yellow
    }
    if ($Coverage -and -not (Get-Command 'cargo-tarpaulin' -ErrorAction SilentlyContinue)) {
        $missing += 'cargo-tarpaulin (cargo install cargo-tarpaulin)'
    }
    if ($missing.Count -gt 0) {
        Write-Host "Missing tools: $($missing -join ', ')" -ForegroundColor Red
        return $false
    }

    $installed = & rustup target list --installed
    foreach ($target in 'wasm32-wasip1', 'wasm32-unknown-unknown') {
        if ($installed -notcontains $target) {
            Write-Host "Installing Rust target $target" -ForegroundColor Yellow
            & rustup target add $target
            if ($LASTEXITCODE -ne 0) { return $false }
        }
    }
    return $true
}

Push-Location $repoRoot
try {
    if (-not (Test-Prerequisites)) { exit 1 }

    $pinnedBun = $null
    if (-not $LocalBun) {
        $ciBun = Get-PinnedBunVersion
        $localBunVersion = (& bun --version).Trim()
        if ($ciBun -and $ciBun -ne $localBunVersion) {
            Write-Host "Local bun is $localBunVersion, CI uses ${ciBun}: running steps with bun@${ciBun}" -ForegroundColor Yellow
            $pinnedBun = $ciBun
        }
    }

    if (-not $SkipInstall) {
        Invoke-Step 'bun install --frozen-lockfile' { Invoke-Bun install --frozen-lockfile }
    }
    Invoke-Step 'bun run lint' { Invoke-Bun run lint }
    Invoke-Step 'bun run typecheck' { Invoke-Bun run typecheck }
    Invoke-Step 'bun run test' { Invoke-Bun run test }
    Invoke-Step 'bun test (TS coverage gate)' { Invoke-Bun test }

    if ($Coverage) {
        Invoke-Step 'Rust coverage (100% gate)' {
            $rustfmtToml = Join-Path $repoRoot '.rustfmt.toml'
            if (Test-Path $rustfmtToml) {
                throw '.rustfmt.toml already exists; remove it before running -Coverage.'
            }
            try {
                # Same wide config as CI: collapses multi-line expressions so
                # tarpaulin can attribute coverage to them.
                @(
                    'max_width = 100000'
                    'tab_spaces = 4'
                    'newline_style = "Unix"'
                    'fn_call_width = 100000'
                    'fn_params_layout = "Compressed"'
                    'chain_width = 100000'
                    'merge_derives = true'
                    'use_small_heuristics = "Default"'
                ) | Set-Content -Path $rustfmtToml -Encoding ascii
                cargo fmt
                if ($LASTEXITCODE -eq 0) { Invoke-Bun run test:coverage }
                $coverageExit = $LASTEXITCODE
            } finally {
                Remove-Item $rustfmtToml -Force -ErrorAction SilentlyContinue
                cargo fmt
            }
            $global:LASTEXITCODE = $coverageExit
        }
    }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Summary' -ForegroundColor Cyan
$results | Format-Table -AutoSize | Out-Host

if ($results | Where-Object { $_.Result -ne 'PASS' }) {
    Write-Host 'CI checks FAILED' -ForegroundColor Red
    exit 1
}
Write-Host 'All CI checks passed' -ForegroundColor Green
exit 0
