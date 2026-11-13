# Runs INSIDE the Windows Sandbox guest (Windows PowerShell 5.1). Every location is derived at run time.
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\stage\scripts\guest-setup.ps1 -Step probe|install|signin|launch|status
# Evidence goes to C:\out (mapped read-write). Never writes or prints credential content.
param([Parameter(Mandatory)][ValidateSet('probe','install','signin','launch','status','desktop','sendkeys','state','workdir','pin','config')][string]$Step,
      [string]$Keys = '', [string]$Label = 'state', [int]$CdpPort = 9222, [int]$ExposedPort = 9223)
$ErrorActionPreference = 'Stop'
$out = 'C:\out'
$stage = 'C:\stage'
function Save($name, $obj) { $obj | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $out $name) }
function CindyExe {
  $roots = @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
  foreach ($r in $roots) {
    $hit = Get-ChildItem -LiteralPath $r -Recurse -Filter 'Cindy*.exe' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notmatch 'Uninstall|Update|Setup|Helper' } | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

switch ($Step) {
  'probe' {
    # Zero configuration before Cindy starts: none of these may exist.
    $cmds = foreach ($n in 'agentcompass','python','python3','py','node','npm','git') {
      $c = Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1
      [pscustomobject]@{ name = $n; on_path = [bool]$c }
    }
    Save 'zero-config-probe.json' ([pscustomobject]@{
      at_utc = (Get-Date).ToUniversalTime().ToString('o')
      commands = $cmds
      agent_compass_dir_exists = (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.agent-compass'))
      codex_dir_exists = (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.codex'))
      claude_dir_exists = (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.claude'))
      os = (Get-CimInstance Win32_OperatingSystem).Caption + ' ' + (Get-CimInstance Win32_OperatingSystem).Version
    })
  }
  'install' {
    $exe = Get-ChildItem -LiteralPath (Join-Path $stage 'installer') -Filter '*.exe' | Select-Object -First 1
    $sig = Get-AuthenticodeSignature -LiteralPath $exe.FullName
    $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe.FullName).Hash.ToLower()
    # /S alone crashed the NSIS helper in earlier guests; /S /currentuser installs.
    $p = Start-Process -FilePath $exe.FullName -ArgumentList '/S','/currentuser' -PassThru -Wait
    $cindy = CindyExe
    Save 'install.json' ([pscustomobject]@{
      installer = $exe.Name; sha256 = $sha; signature = [string]$sig.Status
      signer = $sig.SignerCertificate.Subject; installer_exit = $p.ExitCode
      installed_exe = if ($cindy) { $cindy.Replace($env:USERPROFILE, '%USERPROFILE%') } else { $null }
      product_version = if ($cindy) { (Get-Item -LiteralPath $cindy).VersionInfo.ProductVersion } else { $null }
      at_utc = (Get-Date).ToUniversalTime().ToString('o')
    })
  }
  'signin' {
    # Copy the staged (refresh-token-emptied) sign-ins into this guest's profile.
    $src = Join-Path $stage 'signin'
    $got = [ordered]@{}
    foreach ($pair in @(@('codex','auth.json','.codex'), @('claude','.credentials.json','.claude'))) {
      $f = Join-Path (Join-Path $src $pair[0]) $pair[1]
      $dest = Join-Path $env:USERPROFILE $pair[2]
      if (Test-Path -LiteralPath $f) {
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Copy-Item -LiteralPath $f -Destination (Join-Path $dest $pair[1]) -Force
        $got[$pair[0]] = $true
      } else { $got[$pair[0]] = $false }
    }
    # Claude Code expects its onboarding flag; write a fresh minimal file instead of copying the host's.
    $cj = Join-Path $env:USERPROFILE '.claude.json'
    if (-not (Test-Path -LiteralPath $cj)) { '{"hasCompletedOnboarding":true,"theme":"dark"}' | Set-Content -Encoding UTF8 -LiteralPath $cj }
    Save 'signin-copied.json' $got
  }
  'launch' {
    $cindy = CindyExe
    if (-not $cindy) { throw 'Cindy is not installed' }
    # CDP on loopback, then exposed on the guest address so the host-side driver can reach it without any desktop input.
    Start-Process -FilePath $cindy -ArgumentList "--remote-debugging-port=$CdpPort","--remote-allow-origins=*" | Out-Null
    netsh advfirewall set allprofiles state off | Out-Null
    netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$ExposedPort 2>$null | Out-Null
    netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ExposedPort connectaddress=127.0.0.1 connectport=$CdpPort | Out-Null
    Save 'launch.json' ([pscustomobject]@{ cindy_pid_hint = (Get-Process | Where-Object { $_.Name -like 'Cindy*' } | Select-Object -ExpandProperty Id); cdp = $CdpPort; exposed = $ExposedPort; at_utc = (Get-Date).ToUniversalTime().ToString('o') })
  }
  'state' {
    # Copy the plugin's own state (receipts, router output, caches, cooldowns) so it can be read from the host.
    $src = Join-Path $env:USERPROFILE '.agent-compass\cindy-plugin'
    $dst = Join-Path $out ('state-' + $Label)
    if (Test-Path -LiteralPath $dst) { Remove-Item -Recurse -Force -LiteralPath $dst }
    if (Test-Path -LiteralPath $src) { Copy-Item -Recurse -LiteralPath $src -Destination $dst } else { New-Item -ItemType Directory -Path $dst | Out-Null }
  }
  'workdir' {
    # Set the plugin's Working folder (-Keys <path>) in the signed-in account's errand prefs, without the native folder dialog.
    $id = '_ns__local__agentcompass'
    foreach ($f in Get-ChildItem (Join-Path $env:APPDATA 'CindyGlobal\owners') -Recurse -Filter ghost-errand-prefs.json -ErrorAction SilentlyContinue) {
      $doc = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json
      if ($doc.errand.$id) { $doc.errand.$id | Add-Member -Force -NotePropertyName workingDir -NotePropertyValue $Keys; [IO.File]::WriteAllText($f.FullName, ($doc | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false))) }
    }
  }
  'pin' {
    # Pin the plugin card's model (-Keys <model id>, e.g. one Cindy cannot serve) or, with an empty -Keys, restore "follow the system".
    $id = '_ns__local__agentcompass'
    foreach ($f in Get-ChildItem (Join-Path $env:APPDATA 'CindyGlobal\owners') -Recurse -Filter ghost-errand-prefs.json -ErrorAction SilentlyContinue) {
      $doc = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json
      $e = $doc.errand.$id
      if (-not $e) { continue }
      foreach ($k in 'agentKind','model','effort','fastMode','providerId') { $e.PSObject.Properties.Remove($k) }
      if ($Keys) { foreach ($kv in @{agentKind='pi'; model=$Keys; effort='high'; fastMode=$false; providerId='xd'}.GetEnumerator()) { $e | Add-Member -Force -NotePropertyName $kv.Key -NotePropertyValue $kv.Value } }
      [IO.File]::WriteAllText($f.FullName, ($doc | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    }
  }
  'config' {
    # Write ~/.agent-compass/cindy-plugin/config.json from -Keys (e.g. '{"engine":"cli"}'), or delete it when -Keys is empty.
    $file = Join-Path $env:USERPROFILE '.agent-compass\cindy-plugin\config.json'
    if ($Keys) { New-Item -ItemType Directory -Force -Path (Split-Path $file) | Out-Null; [IO.File]::WriteAllText($file, $Keys, (New-Object Text.UTF8Encoding($false))) }
    elseif (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
  }
  'sendkeys' {
    # Keystrokes into the guest's foreground window (a native folder dialog), e.g. -Keys 'C:\work\proj{ENTER}'.
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
  }
  'desktop' {
    # Screenshot of the whole guest desktop (native dialogs are not reachable over CDP).
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save((Join-Path $out 'desktop.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Save 'desktop-windows.json' (Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, Name, MainWindowTitle)
  }
  'status' {
    Save 'status.json' ([pscustomobject]@{
      processes = (Get-Process | Where-Object { $_.Name -match 'Cindy|codex|claude|node' } | Select-Object Id, Name)
      cdp_listening = [bool](Get-NetTCPConnection -LocalPort $CdpPort -State Listen -ErrorAction SilentlyContinue)
      at_utc = (Get-Date).ToUniversalTime().ToString('o')
    })
  }
}
