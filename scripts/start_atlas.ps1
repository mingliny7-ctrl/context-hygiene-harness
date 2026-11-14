param([ValidateRange(1024, 65535)][int]$Port = 14173)

$atlasDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\plugins\conversation_atlas\frontend'))
$repositoryDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$atlasPython = Join-Path $repositoryDirectory 'plugins\context_hygiene\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $atlasPython)) {
    throw 'Existing Python environment not found. Install dependencies from plugins/context_hygiene/requirements.txt first.'
}
Write-Host "Conversation Atlas: http://127.0.0.1:$Port/"
Write-Host 'Read-only existing SQLite Store. Demo mode: /?source=demo. Press Ctrl+C to stop.'
& $atlasPython -m uvicorn plugins.conversation_atlas.backend.main:app --app-dir $repositoryDirectory --host 127.0.0.1 --port $Port
