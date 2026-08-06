<#
    IndexMePlease - zatrzymanie panelu dzialajacego w tle.

    Uzycie:
        .\stop.ps1
#>

$ErrorActionPreference = "SilentlyContinue"
Set-Location -Path $PSScriptRoot

# Port z pliku .env (domyslnie 8006)
$port = 8006
$fromEnv = Select-String -Path ".env" -Pattern "^PORT=(\d+)" | ForEach-Object { $_.Matches[0].Groups[1].Value }
if ($fromEnv) { $port = [int]$fromEnv }

$owners = Get-NetTCPConnection -LocalPort $port -State Listen |
          Select-Object -ExpandProperty OwningProcess -Unique

if (-not $owners) {
    Write-Host "Panel nie jest uruchomiony (nikt nie nasluchuje na porcie $port)." -ForegroundColor Yellow
    exit 0
}

foreach ($processId in $owners) {
    $process = Get-Process -Id $processId
    Write-Host "Zatrzymywanie $($process.ProcessName) (PID $processId) na porcie $port" -ForegroundColor Cyan
    Stop-Process -Id $processId -Force
}

Start-Sleep -Seconds 1
Remove-Item "data\server.pid" -Force
Write-Host "Panel zatrzymany." -ForegroundColor Green
