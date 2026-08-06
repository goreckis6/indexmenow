# Deploy na Hostingerze

## Który plan Hostingera zadziała

| Plan | Czy zadziała | Dlaczego |
|---|---|---|
| **VPS** | ✅ tak | Pełny dostęp do systemu, Docker, własne porty, procesy w tle |
| Cloud Hosting | ⚠️ tylko z Docker/SSH | Zależy od wariantu — potrzebny dostęp SSH i możliwość uruchomienia własnego procesu |
| Web Hosting (shared) | ❌ nie | Brak długo działających procesów Pythona; scheduler i uvicorn nie mają jak działać |

Panel to aplikacja ASGI z wbudowanym harmonogramem działającym w tle, więc potrzebuje
serwera, na którym proces może żyć nieprzerwanie. **Poniższa instrukcja zakłada VPS.**

---

## Wariant A — Docker Compose (zalecany)

Jedna komenda stawia aplikację i reverse proxy Caddy, który sam pobiera i odnawia
certyfikat HTTPS od Let's Encrypt.

### 1. Domena

W panelu DNS ustaw rekord **A** dla subdomeny, np. `index.twojadomena.pl`,
wskazujący na adres IP Twojego VPS-a. Poczekaj, aż się rozpropaguje:

```bash
dig +short index.twojadomena.pl
```

### 2. Serwer

Zaloguj się przez SSH i zainstaluj Dockera (Ubuntu/Debian):

```bash
curl -fsSL https://get.docker.com | sh
```

### 3. Kod i konfiguracja

```bash
git clone https://github.com/goreckis6/indexmenow.git /opt/indexmenow
cd /opt/indexmenow

cp .env.example .env
nano .env
```

Uzupełnij w `.env`:

```ini
BASE_URL=https://index.twojadomena.pl
DOMAIN=index.twojadomena.pl
SECRET_KEY=<wynik komendy ponizej>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ALLOWED_EMAILS=twoj.adres@gmail.com
```

Wygenerowanie klucza:

```bash
openssl rand -base64 48
```

> `SECRET_KEY` szyfruje tokeny Google w bazie. Zmiana klucza po uruchomieniu
> unieważnia zapisane tokeny i trzeba zalogować się ponownie. Nie trzymaj go w repo.

### 4. Uprawnienia do katalogu z bazą

Kontener działa jako użytkownik o UID 1000, więc katalog na bazę musi do niego należeć:

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

### 5. Start

```bash
docker compose up -d --build
docker compose logs -f app
```

Panel będzie pod `https://index.twojadomena.pl`. Caddy wystawi certyfikat przy
pierwszym żądaniu — jeśli certyfikat się nie pobiera, sprawdź, czy porty 80 i 443
są otwarte i czy rekord A wskazuje na ten serwer.

### 6. Redirect URI w Google

W [Google Cloud Console](https://console.cloud.google.com/apis/credentials) dopisz
do swojego OAuth client ID:

```
https://index.twojadomena.pl/auth/callback
```

Możesz zostawić równolegle wpis lokalny `http://192.168.1.40:8006/auth/callback` —
Google pozwala na wiele adresów, więc panel będzie działał i w domu, i na serwerze.

### Aktualizacja po zmianach w repo

```bash
cd /opt/indexmenow
git pull
docker compose up -d --build
```

### Backup

Cała baza to jeden plik. Kopia i przywracanie:

```bash
docker compose stop app
tar czf ~/indexmenow-backup-$(date +%F).tar.gz data/
docker compose start app
```

---

## Wariant B — bez Dockera (systemd + nginx)

Gdy wolisz uruchomić aplikację bezpośrednio w systemie.

```bash
sudo apt update && sudo apt install -y python3-venv python3-pip nginx
sudo git clone https://github.com/goreckis6/indexmenow.git /opt/indexmenow
cd /opt/indexmenow

python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env && nano .env      # jak w wariancie A
```

Usługa systemd — `/etc/systemd/system/indexmenow.service`:

```ini
[Unit]
Description=IndexMePlease
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/indexmenow
EnvironmentFile=/opt/indexmenow/.env
ExecStart=/opt/indexmenow/.venv/bin/uvicorn app.main:app \
  --host 127.0.0.1 --port 8006 --workers 1 \
  --proxy-headers --forwarded-allow-ips '*'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo chown -R www-data:www-data /opt/indexmenow
sudo systemctl daemon-reload
sudo systemctl enable --now indexmenow
sudo systemctl status indexmenow
```

nginx — `/etc/nginx/sites-available/indexmenow`:

```nginx
server {
    listen 80;
    server_name index.twojadomena.pl;

    location / {
        proxy_pass http://127.0.0.1:8006;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/indexmenow /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d index.twojadomena.pl
```

---

## Ważne przy pracy produkcyjnej

**Tylko jeden worker.** Harmonogram (APScheduler) działa w procesie aplikacji.
Uruchomienie kilku workerów zduplikowałoby zadania i marnowało dzienny limit zgłoszeń
do Google. Konfiguracja w tym repo wymusza `--workers 1`; to w zupełności wystarcza,
bo panel obsługuje pojedynczego użytkownika, a ciężkie operacje i tak lecą w tle.

**Ogranicz dostęp.** Na publicznym adresie koniecznie ustaw `ALLOWED_EMAILS`,
inaczej każdy z kontem Google mógłby założyć konto w Twoim panelu.

**HTTPS jest wymagany.** Gdy `BASE_URL` zaczyna się od `https://`, aplikacja sama
przełącza ciasteczko sesji w tryb `Secure`. Google i tak nie przyjmie produkcyjnego
redirect URI po zwykłym HTTP na publicznej domenie.

**Strefa czasowa.** `TIMEZONE` w `.env` decyduje, o której godzinie rusza
auto-indeksowanie. Serwery VPS domyślnie chodzą na UTC.

**Limity API zostają te same.** 200 zgłoszeń dziennie na projekt Google Cloud —
przeniesienie na serwer tego nie zmienia. Więcej daje dodanie kont serwisowych
w kolejnych projektach (Ustawienia → Konta serwisowe).
