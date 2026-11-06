#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]*$')][string]$Profile,
  [string]$Version = 'latest',
  [string]$DshPath = 'dsh'
)
$ErrorActionPreference = 'Stop'
$tempDir = $null
function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $hash.Dispose() }
}
try {
  $command = Get-Command $DshPath -CommandType Application -ErrorAction Stop
  if ($Version -ne 'latest' -and $Version -notmatch '^v?\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$') {
    throw 'Version must be latest or a release version such as 0.11.0.'
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  if ($Version -eq 'latest') {
    $release = Invoke-RestMethod 'https://api.github.com/repos/reina0721/dsh-bot/releases/latest'
    $Version = [string]$release.tag_name
    if ($Version -notmatch '^v\d+\.\d+\.\d+$') { throw 'Latest stable release has an invalid tag.' }
  }
  $tag = 'v' + ($Version -replace '^v', '')
  $base = 'https://github.com/reina0721/dsh-bot/releases/download/' + $tag
  $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('dsh-bot-install-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempDir | Out-Null
  $archive = Join-Path $tempDir 'dsh-bot.tgz'
  $sums = Join-Path $tempDir 'SHA256SUMS'
  Invoke-WebRequest -UseBasicParsing ($base + '/dsh-bot.tgz') -OutFile $archive
  Invoke-WebRequest -UseBasicParsing ($base + '/SHA256SUMS') -OutFile $sums
  $entries = @(Get-Content -LiteralPath $sums | Where-Object { $_ -match '^[a-fA-F0-9]{64}  dsh-bot\.tgz$' })
  if ($entries.Count -ne 1) { throw 'SHA256SUMS must contain exactly one dsh-bot.tgz checksum.' }
  $expected = $entries[0].Substring(0, 64)
  if ((Get-Sha256 $archive) -ine $expected) { throw 'SHA-256 verification failed; installation stopped.' }
  # DSH records local tarball paths in the profile manifest. Keep the verified
  # archive outside the temporary download directory so later installs still work.
  $dshHome = $env:DSH_HOME
  if (-not $dshHome) { $dshHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
  $cacheDir = Join-Path $dshHome ('plugins-cache/dsh-bot/' + $tag)
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  $cachedArchive = Join-Path $cacheDir 'dsh-bot.tgz'
  if (Test-Path -LiteralPath $cachedArchive) {
    if ((Get-Sha256 $cachedArchive) -ine $expected) { throw 'Cached release differs from download; refusing to replace an installed version.' }
  } else { Move-Item -LiteralPath $archive -Destination $cachedArchive }
  & $command.Source plugin --profile $Profile add $cachedArchive
  if ($LASTEXITCODE -ne 0) { throw "DSH installation failed (exit $LASTEXITCODE)." }
  Write-Host "Installed dsh-bot $tag in profile $Profile. Restart that DSH profile, then open QQ connection settings."
} catch {
  [Console]::Error.WriteLine('dsh-bot install: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($tempDir -and (Test-Path -LiteralPath $tempDir)) {
    # The only recursive deletion target is the unique temporary directory created above.
    $resolved = [IO.Path]::GetFullPath($tempDir)
    $root = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if ($resolved.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved).StartsWith('dsh-bot-install-')) {
      Remove-Item -LiteralPath $resolved -Recurse -Force
    }
  }
}
