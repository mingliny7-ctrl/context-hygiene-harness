param([ValidateRange(1024, 65535)][int]$Port = 4173)

$atlasDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\plugins\conversation_atlas\frontend'))
Write-Host "Conversation Atlas prototype: http://127.0.0.1:$Port/"
Write-Host 'Local mock data only. Press Ctrl+C to stop.'
python -m http.server $Port --bind 127.0.0.1 --directory $atlasDirectory
