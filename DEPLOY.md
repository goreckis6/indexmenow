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

### 1. Domena (`morphyhub.com` — DNS w Cloudflare)

Domena korzysta z nameserverów Cloudflare (`sonny.ns.cloudflare.com`,
`priscilla.ns.cloudflare.com`) i nie ma jeszcze rekordu A. W panelu Cloudflare
→ *DNS → Records* dodaj:

| Typ | Nazwa | Wartość | Proxy |
|---|---|---|---|
| A | `@` | IP Twojego VPS-a | **DNS only** (szara chmurka) |
| A | `www` | IP Twojego VPS-a | **DNS only** |

> **Ustaw najpierw „DNS only”.** Przy włączonym proxy (pomarańczowa chmurka)
> Caddy nie dostanie certyfikatu Let's Encrypt, bo ruch na porcie 80 nie dociera
> bezpośrednio do serwera. Proxy możesz włączyć później — patrz sekcja
> *Cloudflare proxy* na końcu tego dokumentu.

Sprawdzenie propagacji:

```bash
dig +short morphyhub.com @1.1.1.1
```

Jeśli nie chcesz obsługiwać `www`, pomiń ten rekord i usuń blok `www.{$DOMAIN}`
z pliku `deploy/Caddyfile` — inaczej Caddy będzie bezskutecznie próbował pobrać
dla niego certyfikat.

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
BASE_URL=https://morphyhub.com
DOMAIN=morphyhub.com
SECRET_KEY=<wynik komendy ponizej>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ALLOWED_EMAILS=slavomir.gorecki@gmail.com
```

> `BASE_URL` musi być z `https://`, nie `http://`. Google odrzuca redirect URI
> po zwykłym HTTP dla wszystkiego poza `localhost`, a aplikacja przy `https`
> automatycznie przełącza ciasteczko sesji w tryb `Secure`.

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

Panel będzie pod `https://morphyhub.com`. Caddy wystawi certyfikat przy pierwszym
żądaniu — jeśli się nie pobiera, sprawdź, czy porty 80 i 443 są otwarte, czy rekord A
wskazuje na ten serwer i czy proxy Cloudflare jest wyłączone.

Podgląd postępu wystawiania certyfikatu:

```bash
docker compose logs -f caddy
```

### 6. Redirect URI w Google

W [Google Cloud Console](https://console.cloud.google.com/apis/credentials) dopisz
do swojego OAuth client ID oba adresy:

```
https://morphyhub.com/auth/callback
http://192.168.1.40:8006/auth/callback
```

Google pozwala na wiele adresów, więc panel będzie działał równolegle w domu
i na serwerze. Jeśli dodasz też rekord `www`, dopisz `https://www.morphyhub.com/auth/callback`
albo po prostu zawsze wchodź na wersję bez `www` (Caddy i tak tam przekierowuje).

Do listy **Authorized JavaScript origins** nie musisz nic dodawać — panel nie
uruchamia logowania po stronie przeglądarki.

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
    server_name morphyhub.com www.morphyhub.com;

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
sudo certbot --nginx -d morphyhub.com -d www.morphyhub.com
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

**Porty na VPS-ie.** Muszą być otwarte 80 i 443. Na Ubuntu z ufw:

```bash
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw reload
```

Port 8006 zostaw zamknięty — aplikacja jest widoczna tylko dla kontenera Caddy.

---

## Cloudflare proxy (opcjonalnie, po pierwszym uruchomieniu)

Gdy panel już działa na `https://morphyhub.com` z certyfikatem od Caddy, możesz
włączyć proxy Cloudflare (pomarańczowa chmurka), żeby ukryć IP serwera i dostać
ochronę przed botami.

Warunek: w Cloudflare → *SSL/TLS → Overview* ustaw tryb **Full (strict)**.

- Tryb **Flexible** spowoduje pętlę przekierowań — Cloudflare łączy się z serwerem
  po HTTP, a Caddy odsyła z powrotem na HTTPS.
- Tryb **Full (strict)** działa, bo Caddy ma prawdziwy certyfikat Let's Encrypt.

Po włączeniu proxy Caddy nie odnowi już certyfikatu metodą HTTP-01 (ruch na porcie 80
nie dochodzi bezpośrednio). Masz dwie opcje:

1. Na czas odnowienia (co ~60 dni) przełączyć rekord na *DNS only*, albo
2. Włączyć w Cloudflare **Origin Server Certificate** i wskazać go Caddy'emu,
   albo skonfigurować w Caddy wyzwanie DNS-01 z tokenem API Cloudflare.

Najprostsze i w zupełności wystarczające dla panelu używanego przez jedną osobę:
**zostawić DNS only**. Wtedy nic nie wymaga obsługi ręcznej.
