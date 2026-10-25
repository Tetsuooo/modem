# Gives every desktop shortcut that starts this builder (start.bat), whatever its name, the
# modem website's icon (public\favicon.ico: src/assets/modem.ico in several sizes).
# Without -FixOnly (make-shortcut.bat, double-click) it also makes a "modem show builder"
# shortcut if there's none (runs start.bat minimised). start.bat runs it with -FixOnly every
# time the builder starts, so a machine gets the icon after a Sync and a restart, with nothing
# to do by hand (2026-10-25: the Surface's shortcut kept its old blank icon).
param([switch]$FixOnly, [string[]]$Desktops) # -Desktops: other folders than the real desktops (for testing)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bat = Join-Path $here 'start.bat'
$icon = (Join-Path $here 'public\favicon.ico') + ',0'
$sh = New-Object -ComObject WScript.Shell
if (-not $Desktops) { $Desktops = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory')) }
$folders = @($Desktops | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)
$found = 0
$changed = 0
foreach ($d in $folders) {
  Get-ChildItem -LiteralPath $d -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    $lnk = $sh.CreateShortcut($_.FullName)
    if ([string]::Equals($lnk.TargetPath, $bat, [StringComparison]::OrdinalIgnoreCase)) {
      $found++
      if ($lnk.IconLocation -ne $icon) {
        $lnk.IconLocation = $icon
        try { $lnk.Save(); $changed++; Write-Host "Icon set: $($_.FullName)" } catch { Write-Host "Couldn't change $($_.FullName): $($_.Exception.Message)" }
      }
    }
  }
}
if (-not $FixOnly -and $found -eq 0) {
  $path = Join-Path $folders[0] 'modem show builder.lnk'
  $lnk = $sh.CreateShortcut($path)
  $lnk.TargetPath = $bat
  $lnk.WorkingDirectory = $here
  $lnk.IconLocation = $icon
  $lnk.WindowStyle = 7
  $lnk.Description = 'modem show builder'
  $lnk.Save()
  $changed++
  Write-Host "Shortcut made: $path"
}
# Explorer keeps an icon cache: have it draw the new icon now
if ($changed) { Start-Process -FilePath "$env:WINDIR\System32\ie4uinit.exe" -ArgumentList '-show' -WindowStyle Hidden }
if (-not $FixOnly) { Write-Host "Shortcut(s) starting the builder: $([Math]::Max($found, 1)) - all with the modem icon." }
