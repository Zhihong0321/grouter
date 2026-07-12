$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut("C:\Users\Eternalgy\Desktop\Rebuild grouter Switcher.lnk")
$shortcut.TargetPath = "C:\Windows\System32\cmd.exe"
$shortcut.Arguments = '/c ""C:\Users\Eternalgy\projects\claude-reseller-proxy\grouter-switcher\rebuild.bat""'
$shortcut.WorkingDirectory = "C:\Users\Eternalgy\projects\claude-reseller-proxy\grouter-switcher"
$shortcut.IconLocation = "C:\Windows\System32\shell32.dll,238"
$shortcut.Description = "Rebuild the grouter Switcher Tauri app from source"
$shortcut.Save()
Write-Output "created"
