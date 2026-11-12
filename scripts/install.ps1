# Installs the Photon CLI on Windows from a GitHub release.
#
# Environment:
#   PHOTON_VERSION          Version to install (default: the latest release)
#   PHOTON_BIN_DIR          Installation directory (default: ~\.local\bin)
#   PHOTON_NO_MODIFY_PATH   Leave the user PATH unchanged when set
#   PHOTON_REPOSITORY       GitHub repository to install from
#   PHOTON_INSTALLER_GITHUB_BASE_URL
#                           GitHub address to download from (default: https://github.com)

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  Set-StrictMode -Version Latest

  $Program = 'photon'
  $DefaultRepository = 'photon-hq/cli'
  $FirstVersion = '3.0.0'

  function Stop-Install([string]$Message) {
    throw $Message
  }

  function Get-Setting([string]$Name, [string]$Default) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrEmpty($value)) { return $Default }
    return $value
  }

  function Test-Supported([string]$Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { return $false }
    return ([version]$Version) -ge ([version]$FirstVersion)
  }

  function Get-LatestTag([string]$Url) {
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.AllowAutoRedirect = $false
    $request.Method = 'HEAD'
    try {
      $response = $request.GetResponse()
    } catch [System.Net.WebException] {
      $response = $_.Exception.Response
      if ($null -eq $response) {
        Stop-Install "Photon could not look up the latest release at ${Url}: $($_.Exception.Message)"
      }
    }
    try {
      $location = $response.Headers['Location']
    } finally {
      $response.Close()
    }
    if ([string]::IsNullOrEmpty($location)) { return '' }
    return ($location.TrimEnd('/') -split '/')[-1]
  }

  function Get-Architecture {
    try {
      $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    } catch {
      $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    }
    switch -Regex ($architecture) {
      '^(X64|AMD64)$' { return 'x64' }
      '^ARM64$' { return 'arm64' }
      default { Stop-Install "Unsupported architecture: $architecture" }
    }
  }

  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repository = Get-Setting 'PHOTON_REPOSITORY' $DefaultRepository
  $GitHub = (Get-Setting 'PHOTON_INSTALLER_GITHUB_BASE_URL' 'https://github.com').TrimEnd('/')
  $RequestedVersion = Get-Setting 'PHOTON_VERSION' 'latest'
  $BinDir = Get-Setting 'PHOTON_BIN_DIR' (Join-Path $HOME '.local\bin')

  if ($RequestedVersion -eq 'latest') {
    $Tag = Get-LatestTag "$GitHub/$Repository/releases/latest"
    $Version = $Tag -replace '^v', ''
    if (-not (Test-Supported $Version)) {
      $shown = if ($Tag) { $Tag } else { 'missing' }
      Stop-Install "No Photon CLI release $FirstVersion or newer was found: the latest release of $Repository is $shown."
    }
  } else {
    $Version = $RequestedVersion -replace '^v', ''
    if (-not (Test-Supported $Version)) {
      Stop-Install "Photon CLI $RequestedVersion can't be installed: this installer installs stable releases, version $FirstVersion or newer."
    }
  }

  $Artifact = "$Program-windows-$(Get-Architecture).zip"
  $ReleaseUrl = "$GitHub/$Repository/releases/download/v$Version"
  $Temporary = Join-Path ([IO.Path]::GetTempPath()) "photon-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $Temporary | Out-Null

  try {
    $Archive = Join-Path $Temporary $Artifact
    $Checksums = Join-Path $Temporary 'checksums.txt'
    Invoke-WebRequest -Uri "$ReleaseUrl/$Artifact" -OutFile $Archive -UseBasicParsing
    Invoke-WebRequest -Uri "$ReleaseUrl/checksums.txt" -OutFile $Checksums -UseBasicParsing

    $Expected = $null
    foreach ($line in Get-Content -LiteralPath $Checksums) {
      $fields = $line.Trim() -split '\s+'
      if ($fields.Count -ge 2 -and $fields[1].TrimStart('*') -eq $Artifact) {
        $Expected = $fields[0].ToLowerInvariant()
      }
    }
    if (-not $Expected) {
      Stop-Install "No checksum found for $Artifact, so nothing was installed."
    }
    $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) {
      Stop-Install "The download of $Artifact failed its checksum check, so nothing was installed."
    }

    $Extracted = Join-Path $Temporary 'extracted'
    Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted -Force
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $BinDir = (Resolve-Path -LiteralPath $BinDir).Path
    $Target = Join-Path $BinDir "$Program.exe"
    $Staged = Join-Path $BinDir ".$Program.$PID.exe"
    Copy-Item -LiteralPath (Join-Path $Extracted "$Program.exe") -Destination $Staged -Force
    try {
      Move-Item -LiteralPath $Staged -Destination $Target -Force
    } catch {
      Remove-Item -LiteralPath $Staged -Force -ErrorAction SilentlyContinue
      Stop-Install "Photon could not replace ${Target}: $($_.Exception.Message) Close any running $Program and try again."
    }
  } finally {
    Remove-Item -LiteralPath $Temporary -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Output "Installed Photon CLI $Version at $Target"

  $SessionPath = $env:Path -split ';' | Where-Object { $_ }
  if ($SessionPath -contains $BinDir) { return }
  $env:Path = "$BinDir;$env:Path"

  if (-not [string]::IsNullOrEmpty($env:PHOTON_NO_MODIFY_PATH)) {
    Write-Output "To run $Program by name in new terminals, add $BinDir to your PATH."
    return
  }

  $Environment = Get-Item -Path 'HKCU:\Environment'
  $UserPath = [string]$Environment.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $Entries = @($UserPath -split ';' | Where-Object { $_ })
  if ($Entries -notcontains $BinDir) {
    $Kind = if ($Entries.Count -gt 0) { $Environment.GetValueKind('Path') } else { 'ExpandString' }
    Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value ((@($BinDir) + $Entries) -join ';') -Type $Kind
    [Environment]::SetEnvironmentVariable('PHOTON_INSTALLER_PATH_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('PHOTON_INSTALLER_PATH_REFRESH', $null, 'User')
    Write-Output "Added $BinDir to your user PATH."
  }
  Write-Output "Open a new terminal to run $Program."
}
