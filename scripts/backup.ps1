param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\backups'))
$ErrorActionPreference = 'Stop'
Get-Command pg_dump -ErrorAction Stop | Out-Null
# Configure PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSFILE before running.
$backupDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
$backupFile = Join-Path $backupDirectory ('concert-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.dump')
if (Test-Path -LiteralPath $backupFile) { throw 'Backup filename already exists' }
& pg_dump --format=custom --no-owner --schema=public --file=$backupFile
if ($LASTEXITCODE -ne 0) { throw 'Backup failed. Do not use the incomplete dump.' }
& pg_restore --list $backupFile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Backup archive validation failed' }
Get-FileHash -Algorithm SHA256 -LiteralPath $backupFile | Format-List
Write-Output "Backup created: $backupFile"
