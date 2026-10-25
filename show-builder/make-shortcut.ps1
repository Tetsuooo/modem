# Puts a "modem show builder" shortcut on this computer's desktop, or updates the one there:
# it runs start.bat (minimised, like before) with the modem website's icon (src/assets/modem.ico).
# Run it through make-shortcut.bat (double-click).
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$desktop = [Environment]::GetFolderPath('Desktop')
$path = Join-Path $desktop 'modem show builder.lnk'
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
$lnk.TargetPath = Join-Path $here 'start.bat'
$lnk.WorkingDirectory = $here
$lnk.IconLocation = (Join-Path $repo 'src\assets\modem.ico') + ',0'
$lnk.WindowStyle = 7
$lnk.Description = 'modem show builder'
$lnk.Save()
Write-Host "Shortcut ready: $path"
