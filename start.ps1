<#
    IndexMePlease - skrypt startowy dla Windows / PowerShell

    Uzycie:
        .\start.ps1              # instaluje zaleznosci (raz) i uruchamia panel
        .\start.ps1 -Setup       # wymusza ponowna instalacje zaleznosci
        .\start.ps1 -Firewall    # dodaje regule zapory dla portu (wymaga administratora)
#>

param(
    [switch]$Setup,
    [switch]$Firewall
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "    $text" -ForegroundColor Yellow }

# --- interpreter -----------------------------------------------------------
$python = "py"
try { & $python --version | Out-Null } catch { $python = "python" }

# --- srodowisko wirtualne --------------------------------------------------
if (-not (Test-Path ".venv")) {
    Write-Step "Tworzenie srodowiska wirtualnego (.venv)"
    & $python -m venv .venv
    $Setup = $true
}

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

if ($Setup -or -not (Test-Path ".venv\Scripts\uvicorn.exe")) {
    Write-Step "Instalacja zaleznosci"
    & $venvPython -m pip install --upgrade pip --quiet
    & $venvPython -m pip install -r requirements.txt
    Write-Ok "Zaleznosci zainstalowane"
}

# --- plik konfiguracyjny ---------------------------------------------------
if (-not (Test-Path ".env")) {
    Write-Step "Tworzenie pliku .env na podstawie .env.example"
    Copy-Item ".env.example" ".env"

    $secret = & $venvPython -c "import secrets; print(secrets.token_urlsafe(48))"
    $ip = (Get-NetIPAddress -AddressFamily IPv4 |
           Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
           Select-Object -First 1).IPAddress
    if (-not $ip) { $ip = "127.0.0.1" }

    $content = Get-Content ".env" -Raw
    $content = $content -replace "SECRET_KEY=.*", "SECRET_KEY=$secret"
    $content = $content -replace "BASE_URL=.*", "BASE_URL=http://${ip}:8006"
    Set-Content ".env" $content -NoNewline

    Write-Ok "Wygenerowano SECRET_KEY, BASE_URL ustawiony na http://${ip}:8006"
    Write-Warn2 "Uzupelnij GOOGLE_CLIENT_ID i GOOGLE_CLIENT_SECRET w pliku .env"
}

# --- zapora ----------------------------------------------------------------
if ($Firewall) {
    Write-Step "Dodawanie reguly zapory dla portu 8006"
    $port = 8006
    $envPort = Select-String -Path ".env" -Pattern "^PORT=(\d+)" | ForEach-Object { $_.Matches[0].Groups[1].Value }
    if ($envPort) { $port = [int]$envPort }

    $ruleName = "IndexMePlease ($port)"
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
            -LocalPort $port -Action Allow -Profile Private | Out-Null
        Write-Ok "Regula dodana dla portu $port (sieci prywatne)"
    } else {
        Write-Ok "Regula juz istnieje"
    }
}

# --- start -----------------------------------------------------------------
Write-Step "Uruchamianie panelu"
& $venvPython run.py
