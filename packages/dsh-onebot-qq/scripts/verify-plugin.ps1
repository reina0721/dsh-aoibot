#Requires -Version 5.1
<#
.SYNOPSIS
  Verify dsh-onebot-qq against a real DSH installation: create a throwaway profile,
  install this plugin package into it, boot `dsh <profile>` headlessly, then prove the
  host side (REST API) and the web side (client plugin served in the boot page) work.

.DESCRIPTION
  Steps:
    1. preflight: dsh CLI exists, plugin package.json/client.js present, DSH version;
    2. delete + recreate the temporary profile from the shipped `web` template;
    3. `dsh plugin --profile <profile> add <plugin dir>` and assert the bundle is registered;
    4. start `dsh <profile> --port <port> --no-open` in the background (output -> verify-out/);
    5. poll GET /onebot-qq/api/health and GET /onebot-qq/api/status (up to -TimeoutSeconds);
    6. parse the tokenized boot URL from boot.log, fetch the boot page HTML and assert it
       references the dsh-onebot-qq client plugin (`dsh-onebot-qq` + `client.js`);
    7. print PASS/FAIL summary, write verify-out/SUMMARY.txt + verify-out/verify-result.json;
    8. always taskkill /T /F the booted process tree and remove the temporary profile.

  Idempotent and safe to re-run. It never touches the `desktop`/`web` profiles and never
  restarts an already-running DSH GUI (it boots a separate profile on -Port).

.PARAMETER Profile
  Throwaway profile name. Default: onebot-qq-verify.

.PARAMETER Port
  Port for the verification server. Default: 3199.

.PARAMETER DshPath
  Path to dsh.cmd. Default: the DeepSeek Harness installed CLI.

.PARAMETER TimeoutSeconds
  Max time to wait for HTTP health. Default: 60.

.PARAMETER KeepProfile
  Keep the throwaway profile after the run (for manual inspection).

.PARAMETER KeepServer
  Leave the booted DSH process running (prints its PID; kill it yourself afterwards).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-plugin.ps1

.EXAMPLE
  pwsh -File scripts/verify-plugin.ps1 -Port 3199 -TimeoutSeconds 90
#>
[CmdletBinding()]
param(
  [string]$Profile = 'onebot-qq-verify',
  [int]$Port = 3199,
  [string]$DshPath = 'C:\Users\Run\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [int]$TimeoutSeconds = 60,
  [switch]$KeepProfile,
  [switch]$KeepServer
)

$ErrorActionPreference = 'Stop'

$script:pluginRoot = Split-Path -Parent $PSScriptRoot
$script:outDir = Join-Path $script:pluginRoot 'verify-out'
$script:steps = @()
$script:serverPid = 0
$script:previousDataDir = $env:DSH_ONEBOT_QQ_DATA_DIR
$script:startedAt = (Get-Date)
$script:dataDir = ''
$script:bootUrl = ''
$script:dshVersion = ''
$script:profileDir = ''

New-Item -ItemType Directory -Force -Path $script:outDir | Out-Null

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

function Write-Utf8File {
  param([string]$Path, [string]$Text)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Add-Step {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  $entry = [pscustomobject]@{
    name   = $Name
    ok     = $Ok
    detail = $Detail
    at     = (Get-Date).ToString('o')
  }
  $script:steps += $entry
  if ($Ok) {
    Write-Host ("  [PASS] " + $Name + $(if ($Detail) { " - " + $Detail } else { '' })) -ForegroundColor Green
  } else {
    Write-Host ("  [FAIL] " + $Name + $(if ($Detail) { " - " + $Detail } else { '' })) -ForegroundColor Red
  }
}

function Test-AllStepsPassed {
  $failed = @($script:steps | Where-Object { -not $_.ok })
  return ($failed.Count -eq 0)
}

function Get-ListeningProcess {
  param([int]$ListenPort)
  try {
    return @(Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue)
  } catch {
    return @()
  }
}

function Stop-ServerTree {
  if ($script:serverPid -le 0) { return }
  Write-Host ("  stopping DSH process tree (pid " + $script:serverPid + ") ...")
  try {
    & taskkill /PID $script:serverPid /T /F 2>&1 | Out-Null
  } catch {}
  for ($i = 0; $i -lt 40; $i++) {
    if ((Get-ListeningProcess -ListenPort $Port).Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  }
  # Last resort: kill whatever still listens on the verification port.
  foreach ($listener in (Get-ListeningProcess -ListenPort $Port)) {
    try { & taskkill /PID $listener.OwningProcess /T /F 2>&1 | Out-Null } catch {}
  }
  Start-Sleep -Milliseconds 500
}

function Invoke-Cleanup {
  if (-not $KeepServer) {
    $hadServer = ($script:serverPid -gt 0)
    Stop-ServerTree
    $free = ((Get-ListeningProcess -ListenPort $Port).Count -eq 0)
    if ($hadServer) {
      Add-Step 'cleanup: DSH process tree stopped' $free ("port " + $Port + " " + $(if ($free) { 'released' } else { 'STILL IN USE' }))
    }
  } else {
    Write-Host ("  -KeepServer: leaving DSH running with pid " + $script:serverPid + " on port " + $Port)
  }

  if (-not $KeepProfile -and $script:profileDir) {
    if (Test-Path -LiteralPath $script:profileDir) {
      try {
        Remove-Item -LiteralPath $script:profileDir -Recurse -Force -ErrorAction Stop
        Add-Step 'cleanup: temporary profile removed' $true $script:profileDir
      } catch {
        Add-Step 'cleanup: temporary profile removed' $false ("could not remove " + $script:profileDir + ": " + $_.Exception.Message)
      }
    }
  } elseif ($KeepProfile) {
    Write-Host ("  -KeepProfile: profile kept at " + $script:profileDir)
  }

  if ($null -eq $script:previousDataDir) {
    Remove-Item Env:\DSH_ONEBOT_QQ_DATA_DIR -ErrorAction SilentlyContinue
  } else {
    $env:DSH_ONEBOT_QQ_DATA_DIR = $script:previousDataDir
  }
}

function Write-Summary {
  $allOk = Test-AllStepsPassed
  $result = $(if ($allOk) { 'PASS' } else { 'FAIL' })
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('dsh-onebot-qq real-DSH verification')
  $lines.Add('==================================')
  $lines.Add('result:     ' + $result)
  $lines.Add('started:    ' + $script:startedAt.ToString('o'))
  $lines.Add('finished:   ' + (Get-Date).ToString('o'))
  $lines.Add('plugin:     ' + $script:pluginRoot)
  $lines.Add('dsh:        ' + $DshPath + ' (version ' + $script:dshVersion + ')')
  $lines.Add('profile:    ' + $Profile)
  $lines.Add('port:       ' + $Port)
  $lines.Add('data dir:   ' + $script:dataDir)
  $lines.Add('boot url:   ' + $script:bootUrl)
  $lines.Add('evidence:   ' + $script:outDir)
  $lines.Add('')
  foreach ($step in $script:steps) {
    $tag = $(if ($step.ok) { 'PASS' } else { 'FAIL' })
    $lines.Add('[' + $tag + '] ' + $step.name + $(if ($step.detail) { ' - ' + $step.detail } else { '' }))
  }
  $lines.Add('')
  $text = $lines -join [Environment]::NewLine
  Write-Utf8File -Path (Join-Path $script:outDir 'SUMMARY.txt') -Text $text

  $resultObject = [pscustomobject]@{
    ok          = $allOk
    startedAt   = $script:startedAt.ToString('o')
    finishedAt  = (Get-Date).ToString('o')
    dshPath     = $DshPath
    dshVersion  = $script:dshVersion
    profile     = $Profile
    port        = $Port
    dataDir     = $script:dataDir
    bootUrl     = $script:bootUrl
    pluginRoot  = $script:pluginRoot
    evidenceDir = $script:outDir
    steps       = $script:steps
  }
  Write-Utf8File -Path (Join-Path $script:outDir 'verify-result.json') -Text ($resultObject | ConvertTo-Json -Depth 6)

  Write-Host ''
  Write-Host $text
  return $allOk
}

# ---------------------------------------------------------------------------
# main verification
# ---------------------------------------------------------------------------

function Invoke-Verify {
  Write-Host ''
  Write-Host '== dsh-onebot-qq real-DSH verification ==' -ForegroundColor Cyan
  Write-Host ('plugin: ' + $script:pluginRoot)
  Write-Host ('output: ' + $script:outDir)
  Write-Host ''

  # --- 0. clean previous evidence -----------------------------------------
  Get-ChildItem -LiteralPath $script:outDir -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  # --- 1. preflight --------------------------------------------------------
  Write-Host '-- preflight'
  $dshOk = Test-Path -LiteralPath $DshPath
  Add-Step 'preflight: dsh CLI exists' $dshOk $DshPath
  if (-not $dshOk) { return }

  $versionOutput = & $DshPath --version 2>&1
  $script:dshVersion = (@($versionOutput) | ForEach-Object { [string]$_ }) -join ' '
  $script:dshVersion = $script:dshVersion.Trim()
  Add-Step 'preflight: dsh --version' ($script:dshVersion.Length -gt 0) $script:dshVersion

  $pkgFile = Join-Path $script:pluginRoot 'package.json'
  $pkgOk = Test-Path -LiteralPath $pkgFile
  Add-Step 'preflight: plugin package.json exists' $pkgOk $pkgFile
  if (-not $pkgOk) { return }

  $pkg = Get-Content -LiteralPath $pkgFile -Raw | ConvertFrom-Json
  Add-Step 'preflight: package name is dsh-onebot-qq' ($pkg.name -eq 'dsh-onebot-qq') ([string]$pkg.name)

  $clientFile = Join-Path $script:pluginRoot 'client.js'
  $clientOk = Test-Path -LiteralPath $clientFile
  Add-Step 'preflight: client.js (web panel half) exists' $clientOk $(if ($clientOk) { $clientFile } else { 'missing: DSH cannot serve the panel client plugin' })

  $protected = @('desktop', 'web', 'tui', 'headless', 'rescue', 'sdk', 'sdk-minimal', 'lead-probe')
  if ($protected -contains $Profile.ToLowerInvariant()) {
    Add-Step 'preflight: profile name is a throwaway profile' $false ('refusing to touch protected profile: ' + $Profile)
    return
  }
  Add-Step 'preflight: profile name is a throwaway profile' $true $Profile

  $profilesRoot = Join-Path (Join-Path $env:USERPROFILE '.dsh') 'profiles'
  $script:profileDir = Join-Path $profilesRoot $Profile
  $rootFull = [System.IO.Path]::GetFullPath($profilesRoot)
  $targetFull = [System.IO.Path]::GetFullPath($script:profileDir)
  $rootPrefix = $rootFull.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  if (-not $targetFull.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    Add-Step 'preflight: profile path inside $DSH_HOME/profiles' $false $targetFull
    return
  }
  Add-Step 'preflight: profile path inside $DSH_HOME/profiles' $true $targetFull

  $busy = Get-ListeningProcess -ListenPort $Port
  if ($busy.Count -gt 0) {
    $owner = ($busy | ForEach-Object { [string]$_.OwningProcess }) -join ','
    Add-Step 'preflight: verification port is free' $false ('port ' + $Port + ' already in use by pid ' + $owner + '; close it or pass -Port <other>')
    return
  }
  Add-Step 'preflight: verification port is free' $true ('port ' + $Port)

  # --- 2. recreate throwaway profile --------------------------------------
  Write-Host '-- profile'
  if (Test-Path -LiteralPath $script:profileDir) {
    try {
      Remove-Item -LiteralPath $script:profileDir -Recurse -Force -ErrorAction Stop
      Add-Step 'profile: old throwaway profile removed' $true $script:profileDir
    } catch {
      Add-Step 'profile: old throwaway profile removed' $false $_.Exception.Message
      return
    }
  } else {
    Add-Step 'profile: old throwaway profile removed' $true '(none existed)'
  }

  $createLog = Join-Path $script:outDir 'profile-create.log'
  & $DshPath --profile $Profile --from-default-profile web --dump-config *> $createLog
  $createCode = $LASTEXITCODE
  $profileManifest = Join-Path $script:profileDir 'package.json'
  $created = (($createCode -eq 0) -and (Test-Path -LiteralPath $profileManifest))
  Add-Step 'profile: created from the shipped web template' $created ('exit=' + $createCode + '; log=' + $createLog)
  if (-not $created) { return }

  # --- 3. install plugin ---------------------------------------------------
  Write-Host '-- install plugin'
  $addLog = Join-Path $script:outDir 'plugin-add.log'
  & $DshPath plugin --profile $Profile add $script:pluginRoot *> $addLog
  $addCode = $LASTEXITCODE
  $installed = ($addCode -eq 0)
  $manifest = $null
  try { $manifest = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json } catch { $manifest = $null }
  $dependency = $null
  if ($manifest -and $manifest.dependencies) { $dependency = [string]$manifest.dependencies.'dsh-onebot-qq' }
  $bundles = @()
  if ($manifest -and $manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
    $bundles = @($manifest.dsh.profile.bundles)
  }
  $bundleRegistered = ($bundles -contains 'dsh-onebot-qq')
  Add-Step 'install: plugin added as profile dependency' (($null -ne $dependency) -and $installed) ('dependency=' + $dependency + '; exit=' + $addCode + '; log=' + $addLog)
  Add-Step 'install: dsh-onebot-qq registered in dsh.profile.bundles' $bundleRegistered (($bundles -join ', '))

  if (-not $installed) {
    Add-Step 'install: plugin installation succeeded' $false ('dsh plugin add exited ' + $addCode + '; see ' + $addLog)
    return
  }

  # --- 4. boot headless ----------------------------------------------------
  Write-Host '-- boot'
  $script:dataDir = Join-Path $script:outDir 'plugin-data'
  if (Test-Path -LiteralPath $script:dataDir) { Remove-Item -LiteralPath $script:dataDir -Recurse -Force -ErrorAction SilentlyContinue }
  $script:previousDataDir = $env:DSH_ONEBOT_QQ_DATA_DIR
  $env:DSH_ONEBOT_QQ_DATA_DIR = $script:dataDir


  $bootLog = Join-Path $script:outDir 'boot.log'
  $bootErr = Join-Path $script:outDir 'boot.err.log'
  Remove-Item -LiteralPath $bootLog, $bootErr -Force -ErrorAction SilentlyContinue
  $cmdLine = '/c ""' + $DshPath + '" ' + $Profile + ' --port ' + $Port + ' --no-open"'
  $proc = Start-Process -FilePath $env:ComSpec -ArgumentList $cmdLine -RedirectStandardOutput $bootLog -RedirectStandardError $bootErr -PassThru -WindowStyle Hidden
  $script:serverPid = $proc.Id
  Write-Utf8File -Path (Join-Path $script:outDir 'server.pid') -Text ([string]$script:serverPid)
  Add-Step 'boot: DSH started in background' ($script:serverPid -gt 0) ('pid=' + $script:serverPid + '; boot log=' + $bootLog)

  # --- 5. poll health / status --------------------------------------------
  Write-Host '-- probe REST API'
  $base = 'http://127.0.0.1:' + $Port
  $health = $null
  $attempts = 0
  $trace = New-Object System.Collections.Generic.List[string]
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $attempts++
    if ($proc.HasExited) {
      $trace.Add('server process exited before health became ready')
      break
    }
    try {
      $response = Invoke-RestMethod -Uri ($base + '/onebot-qq/api/health') -TimeoutSec 2
      if ($response -and $response.ok -eq $true) {
        $health = $response
        $trace.Add('attempt ' + $attempts + ': health ok (state=' + [string]$response.state + ')')
        break
      }
      $trace.Add('attempt ' + $attempts + ': health ok=false')
    } catch {
      $trace.Add('attempt ' + $attempts + ': ' + $_.Exception.Message)
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Utf8File -Path (Join-Path $script:outDir 'health-poll.log') -Text (($trace -join [Environment]::NewLine) + [Environment]::NewLine)

  $healthOk = ($null -ne $health) -and ($health.ok -eq $true)
  Add-Step 'api: GET /onebot-qq/api/health is ok' $healthOk $(if ($healthOk) { 'state=' + [string]$health.state + '; version=' + [string]$health.version + '; attempts=' + $attempts } else { 'not healthy within ' + $TimeoutSeconds + 's; see health-poll.log + boot.err.log' })

  $statusOk = $false
  if ($healthOk) {
    try {
      $status = Invoke-RestMethod -Uri ($base + '/onebot-qq/api/status') -TimeoutSec 5
      $statusOk = ($status.ok -eq $true) -and ($null -ne $status.gateway) -and ($null -ne $status.gateway.state)
      $statusDetail = ''
      if ($statusOk) { $statusDetail = 'gateway.state=' + [string]$status.gateway.state + '; apiVersion=' + [string]$status.apiVersion }
      Add-Step 'api: GET /onebot-qq/api/status returns a gateway snapshot' $statusOk $statusDetail

      $dataDirMatches = $false
      if ($statusOk) {
        try {
          $reported = [System.IO.Path]::GetFullPath([string]$status.dataDir)
          $expected = [System.IO.Path]::GetFullPath($script:dataDir)
          $dataDirMatches = $reported.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)
        } catch { $dataDirMatches = $false }
      }
      Add-Step 'api: DSH_ONEBOT_QQ_DATA_DIR override honored (isolated verification data)' $dataDirMatches ('reported=' + [string]$status.dataDir)

      $configFile = Join-Path $script:dataDir 'config.json'
      $configOk = Test-Path -LiteralPath $configFile
      Add-Step 'api: plugin wrote its config.json into the isolated data dir' $configOk $configFile

      $groupsOk = $false
      try {
        $configPayload = Invoke-RestMethod -Uri ($base + '/onebot-qq/api/config') -TimeoutSec 5
        $groupsOk = ($configPayload.ok -eq $true) -and ($null -ne $configPayload.groups) -and (@($configPayload.groups).Count -gt 0)
      } catch { $groupsOk = $false }
      Add-Step 'api: GET /onebot-qq/api/config exposes the field groups' $groupsOk ''

      $cognitionOk = $false
      $cognitionDetail = ''
      try {
        $cognitionPayload = Invoke-RestMethod -Uri ($base + '/onebot-qq/api/cognition/overview') -TimeoutSec 8
        $cogDb = Join-Path $script:dataDir 'cognition/cognition.sqlite'
        $cognitionOk = ($cognitionPayload.ok -eq $true) -and ($cognitionPayload.ready -eq $true) -and (Test-Path -LiteralPath $cogDb)
        $cognitionDetail = 'ready=' + [string]$cognitionPayload.ready + '; mode=' + [string]$cognitionPayload.mode + '; skills=' + [string]$cognitionPayload.counts.skill
      } catch { $cognitionDetail = $_.Exception.Message }
      Add-Step 'cognition: overview API ready and SQLite database created' $cognitionOk $cognitionDetail

      $modelsOk = $false
      $modelsDetail = ''
      try {
        $modelsPayload = Invoke-RestMethod -Uri ($base + '/onebot-qq/api/models') -TimeoutSec 8
        $modelsOk = ($modelsPayload.ok -eq $true) -and ($null -ne $modelsPayload.presets) -and (@($modelsPayload.presets).Count -gt 5) -and ($null -ne $modelsPayload.protocols) -and (@($modelsPayload.protocols).Count -ge 5)
        $modelsDetail = 'presets=' + [string]@($modelsPayload.presets).Count + '; protocols=' + [string]@($modelsPayload.protocols).Count + '; providers=' + [string]@($modelsPayload.providers).Count
      } catch { $modelsDetail = $_.Exception.Message }
      Add-Step 'models: protocol presets and provider API available' $modelsOk $modelsDetail
    } catch {
      Add-Step 'api: GET /onebot-qq/api/status returns a gateway snapshot' $false $_.Exception.Message
    }
  }

  # --- 6. boot page: panel client plugin is served --------------------------
  Write-Host '-- web boot page'
  # The boot log file is held open by cmd.exe/child while the server runs; use
  # Get-Content (FileShare.ReadWrite) rather than [IO.File]::ReadAllText, which
  # fails with a sharing violation and would silently parse an empty log.
  $bootText = ''
  $urlMatch = $null
  $urlDeadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $urlDeadline) {
    $bootText = ''
    if (Test-Path -LiteralPath $bootLog) {
      try { $bootText = [string](Get-Content -LiteralPath $bootLog -Raw -ErrorAction Stop) } catch { $bootText = '' }
    }
    if ($bootText.Length -gt 0) {
      $candidate = [regex]::Match($bootText, 'https?://(?:127\.0\.0\.1|localhost):\d+/\?token=[^\s"'']+')
      if ($candidate.Success) { $urlMatch = $candidate; break }
    }
    if ($proc.HasExited) { break }
    Start-Sleep -Milliseconds 250
  }
  $urlOk = ($null -ne $urlMatch)
  if ($urlOk) {
    $script:bootUrl = $urlMatch.Value
  } else {
    $bootErrText = ''
    if (Test-Path -LiteralPath $bootErr) {
      try { $bootErrText = [string](Get-Content -LiteralPath $bootErr -Raw -ErrorAction Stop) } catch { $bootErrText = '' }
    }
    if ($bootErrText.Length -gt 0) {
      $urlDetail = 'boot.err.log tail: ' + $bootErrText.Substring([Math]::Max(0, $bootErrText.Length - 400)).Trim()
    } else {
      $urlDetail = 'no tokenized URL in boot.log yet; process exited=' + $proc.HasExited
    }
    Add-Step 'web: parsed tokenized boot URL from boot.log' $false $urlDetail
  }
  if ($urlOk) {
    Add-Step 'web: parsed tokenized boot URL from boot.log' $true $script:bootUrl
  }

  $html = ''
  $pageOk = $false
  $pageError = ''
  if ($urlOk) {
    try {
      $page = Invoke-WebRequest -Uri $script:bootUrl -UseBasicParsing -TimeoutSec 15
      $pageOk = ($page.StatusCode -eq 200)
      $html = [string]$page.Content
      Write-Utf8File -Path (Join-Path $script:outDir 'boot-page.html') -Text $html
    } catch {
      $pageError = $_.Exception.Message
    }
  } else {
    $pageError = 'no tokenized URL in boot.log; see boot.log'
  }
  if ($pageOk) {
    Add-Step 'web: GET boot page with token' $true ('bytes=' + $html.Length + '; saved to boot-page.html')
  } else {
    Add-Step 'web: GET boot page with token' $false $pageError
  }

  $hasPluginEntry = $html.Contains('"id":"dsh-onebot-qq"') -or $html.Contains('dsh-onebot-qq/client.js') -or $html.Contains('dsh-onebot-qq%2Fclient.js')
  if (-not $hasPluginEntry -and $html.Length -gt 0) { $hasPluginEntry = $html.Contains('dsh-onebot-qq') }
  Add-Step 'web: boot page references the dsh-onebot-qq client plugin' $hasPluginEntry 'expects dsh-onebot-qq in the __DSH_BOOT__ plugin list'

  $hasClientJs = $html.Contains('client.js')
  Add-Step 'web: boot page references client.js assets' $hasClientJs 'every DSH client plugin is served as client.js'

  if ($html.Length -gt 0) {
    $index = $html.IndexOf('dsh-onebot-qq')
    if ($index -ge 0) {
      $start = [Math]::Max(0, $index - 200)
      $length = [Math]::Min(600, $html.Length - $start)
      Write-Utf8File -Path (Join-Path $script:outDir 'boot-page-plugin-snippet.txt') -Text $html.Substring($start, $length)
    }
  }

  Write-Host '-- done collecting evidence'
}

# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------

try {
  Invoke-Verify
} catch {
  Add-Step 'verification: unexpected error' $false ($_.Exception.Message)
} finally {
  Invoke-Cleanup
}

$allOk = Write-Summary
Write-Host ''
if ($allOk) {
  Write-Host 'RESULT: PASS' -ForegroundColor Green
  exit 0
} else {
  Write-Host 'RESULT: FAIL' -ForegroundColor Red
  Write-Host ('see ' + $script:outDir + ' for evidence (boot.log, boot.err.log, boot-page.html, SUMMARY.txt)')
  exit 1
}
