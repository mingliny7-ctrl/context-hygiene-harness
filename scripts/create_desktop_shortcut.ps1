$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pythonw = Join-Path $projectRoot 'plugins\context_hygiene\.venv\Scripts\pythonw.exe'
$atlasIcon = Join-Path $projectRoot 'plugins\conversation_atlas\assets\atlas-icon.ico'
if (-not (Test-Path -LiteralPath $pythonw -PathType Leaf)) {
    throw "Existing Python environment not found: $pythonw"
}

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not (Test-Path -LiteralPath $desktop -PathType Container)) {
    throw "Desktop folder not found: $desktop"
}

$shortcutPath = Join-Path $desktop 'Conversation Atlas.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pythonw
$shortcut.Arguments = '-m shared.desktop_host.desktop_start'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = if (Test-Path -LiteralPath $atlasIcon -PathType Leaf) { "$atlasIcon,0" } else { "$pythonw,0" }
$shortcut.Description = '启动 Conversation Collector 和 Atlas，然后打开图谱'
$shortcut.Save()
Write-Output $shortcutPath
