# Deploy na Hostingerze

## Potrzebny jest VPS — „Deploy Your Web App” tu nie zadziała

Kreator **Add Website → Node.js web app** (nazywany też „Deploy Your Web App”) obsługuje
**wyłącznie projekty JavaScriptowe**. Wymaga pliku `package.json` i pozwala wybrać tylko
frameworki Node — Next.js, Express, Nuxt, Astro, NestJS, Fastify, React i podobne.
Ten panel jest napisany w Pythonie (FastAPI + uvicorn), więc nie ma tam czego wykryć.

Jeśli zobaczysz komunikat *„This repository is missing a package.json file. Add a
package.json file to your repo to enable full import, or continue as a static website”* —
jesteś w złym kreatorze. **Nie wybieraj „continue as a static website”**: tryb statyczny
tylko serwuje pliki z repozytorium, nie uruchamia Pythona. Dostałbyś stronę pokazującą
surowy kod zamiast działającego panelu, bez logowania Google, bez bazy i bez harmonogramu.

| Plan | Czy zadziała | Dlaczego |
|---|---|---|
| **VPS** | ✅ tak | Docker, własne porty, procesy w tle — jedyna ścieżka dla tego projektu |
| Cloud / Business Hosting | ❌ nie | Kreator web app przyjmuje tylko Node.js; Pythona z harmonogramem nie uruchomisz |
| Web Hosting (shared) | ❌ nie | Brak długo działających procesów Pythona; scheduler i uvicorn nie mają jak działać |

Panel to aplikacja ASGI z wbudowanym harmonogramem działającym w tle, więc potrzebuje
serwera, na którym proces może żyć nieprzerwanie. Właściwe miejsce w hPanel to
**VPS → Docker Manager**, a nie sekcja Websites. **Cała poniższa instrukcja zakłada VPS.**

---

## Zmienne środowiskowe

To jedyna rzecz, którą trzeba uzupełnić ręcznie — niezależnie od tego, czy wdrażasz
przez Hostinger Docker Manager, GitHub Action, czy komendą na serwerze.
`docker-compose.yml` nie czyta pliku `.env` z repozytorium (go tam nie ma), tylko
podstawia te zmienne.

### Wymagane

| Zmienna | Wartość dla morphyhub.com | Skąd wziąć |
|---|---|---|
| `DOMAIN` | `morphyhub.com` | Domena dla certyfikatu Caddy — bez `https://` i bez ukośnika |
| `BASE_URL` | `https://morphyhub.com` | Pełny adres panelu. **Musi być `https`** i identyczny z redirect URI w Google |
| `SECRET_KEY` | losowy ciąg | `openssl rand -base64 48` |
| `GOOGLE_CLIENT_ID` | `...apps.googleusercontent.com` | Google Cloud Console → Credentials |
| `GOOGLE_CLIENT_SECRET` | `GOCSPX-...` | jw. |

Brak którejkolwiek z nich zatrzyma deploy z komunikatem wskazującym, czego brakuje —
lepsze to niż panel, który wstaje z niedziałającym logowaniem.

### Zalecane

| Zmienna | Wartość | Po co |
|---|---|---|
| `ALLOWED_EMAILS` | `slavomir.gorecki@gmail.com` | Bez tego każdy z kontem Google założy konto w Twoim panelu |
| `TIMEZONE` | `Europe/Warsaw` | VPS domyślnie chodzi na UTC, więc harmonogram ruszyłby o innej godzinie |

### Opcjonalne (mają sensowne wartości domyślne)

`AUTO_INDEX_HOUR` (3), `DEFAULT_DAILY_QUOTA` (200), `SITEMAP_SCAN_INTERVAL_HOURS` (12),
`INSPECTION_BATCH_SIZE` (50), `API_THROTTLE_SECONDS` (0.6), `RECHECK_AFTER_DAYS` (7),
`LOG_LEVEL` (INFO).

`IMAGE_TAG` (domyślnie `latest`) wskazuje wersję obrazu z GHCR. Każdy build taguje
obraz również skrótem commita, więc ustawiając tu konkretny SHA wracasz do
poprzedniej wersji bez cofania zmian w repozytorium.

### Czego NIE ustawiać

`HOST`, `PORT` i `DATABASE_URL` są na stałe wpisane w `docker-compose.yml`.
Nadpisanie ich rozjedzie konfigurację z reverse proxy albo odetnie panel od bazy.

### Gotowy blok do wklejenia

```
DOMAIN=morphyhub.com
BASE_URL=https://morphyhub.com
SECRET_KEY=TUTAJ_WYNIK_openssl_rand_base64_48
GOOGLE_CLIENT_ID=TUTAJ_CLIENT_ID
GOOGLE_CLIENT_SECRET=TUTAJ_CLIENT_SECRET
ALLOWED_EMAILS=slavomir.gorecki@gmail.com
TIMEZONE=Europe/Warsaw
```

---

## Wariant A — GitHub Action (deploy po każdym push) ← zalecany

Workflow `.github/workflows/deploy.yml` robi dwie rzeczy przy każdym pushu na `main`:

1. **buduje obraz Dockera** i wypycha go do GitHub Container Registry jako
   `ghcr.io/goreckis6/indexmenow:latest`,
2. **woła API Hostingera**, które pobiera `docker-compose.yml` i restartuje projekt
   na świeżym obrazie.

Krok 2 jest pomijany, dopóki nie ustawisz zmiennej `HOSTINGER_VM_ID` — więc build
możesz przetestować, zanim w ogóle dotkniesz Hostingera.

### Jak działa deploy (i co z tego wynika)

Akcja Hostingera **nie klonuje repozytorium**. Wysyła do API tylko adres URL do
jednego pliku: `https://github.com/<repo>/blob/<sha>/docker-compose.yml`. Serwer
Hostingera pobiera ten plik i uruchamia go u siebie. Stąd trzy konsekwencje, które
łatwo przeoczyć:

**Repozytorium musi być publiczne.** Hostinger pobiera plik compose bez logowania,
więc przy prywatnym repo dostanie 404 i deploy padnie. Jeśli kod ma zostać prywatny,
użyj wariantu C (ręczny `git clone` przez SSH). Sam plik compose nie zawiera sekretów
— wszystkie hasła wchodzą zmiennymi środowiskowymi.

**Paczka w GHCR musi być publiczna.** Po pierwszym udanym buildzie wejdź w profil
GitHuba → *Packages* → `indexmenow` → *Package settings* → *Change visibility* →
**Public**. Inaczej VPS nie pobierze obrazu, bo nie ma gdzie się zalogować. Obraz
zawiera wyłącznie kod aplikacji, konfiguracja dochodzi z zewnątrz.

**W `docker-compose.yml` nie ma `build:` ani plików montowanych z dysku hosta.**
Na serwerze istnieje tylko ten jeden plik YAML, więc nie ma czego budować ani co
montować. Dlatego obraz jest gotowy z rejestru, a Caddy dostaje konfigurację jedną
komendą (`caddy reverse-proxy`) zamiast pliku `Caddyfile`. Jeśli będziesz edytować
ten plik, nie dodawaj do niego ścieżek typu `./coś` — deploy przestanie działać.

### Konfiguracja w GitHubie

*Settings → Secrets and variables → Actions*:

**Zakładka Secrets** (wartości ukryte):

| Nazwa | Wartość |
|---|---|
| `HOSTINGER_API_KEY` | Token API z hPanel → *Account → API* |
| `SECRET_KEY` | Wynik `openssl rand -base64 48` |
| `GOOGLE_CLIENT_ID` | Z Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Z Google Cloud Console |

**Zakładka Variables** (wartości jawne):

| Nazwa | Wartość |
|---|---|
| `HOSTINGER_VM_ID` | ID maszyny — widoczne w adresie URL panelu VPS |
| `DOMAIN` | `morphyhub.com` |
| `BASE_URL` | `https://morphyhub.com` |
| `ALLOWED_EMAILS` | `slavomir.gorecki@gmail.com` |

Tokena GitHuba nie ustawiasz — do wypchnięcia obrazu workflow używa wbudowanego
`GITHUB_TOKEN`.

### Kolejność uruchamiania

1. Rekord A w Cloudflare (patrz wariant C, punkt 1) — **przed** pierwszym deployem.
   Caddy sięga po certyfikat zaraz po starcie i bez DNS-u dostanie błąd.
2. VPS z szablonem zawierającym Dockera.
3. Sekrety i zmienne jak wyżej.
4. Push na `main` albo *Actions → Build i deploy na Hostinger VPS → Run workflow*.

---

## Wariant B — Hostinger Docker Manager (klikany ręcznie)

To samo co wyżej, tylko bez CI. W hPanel wejdź w **VPS → zarządzanie serwerem →
Docker Manager** (nie w *Websites* — tam jest kreator wyłącznie dla Node.js),
wybierz *Compose from URL*, wskaż `docker-compose.yml` z tego repozytorium,
a zmienne z bloku powyżej wklej w polu **Environment variables**.

Obowiązują te same dwa warunki: publiczne repo (albo
[klucz deploy SSH](https://www.hostinger.com/support/how-to-deploy-from-private-github-repository-on-hostinger-docker-manager/))
i publiczna paczka w GHCR. Obraz musi już tam być, więc najpierw pozwól workflow
zbudować go choć raz.

Alternatywnie zamiast *Compose from URL* możesz wkleić zawartość
`docker-compose.yml` bezpośrednio w edytorze — wtedy repo może zostać prywatne,
ale każdą zmianę w pliku trzeba przenieść ręcznie.

---

## Wariant C — ręcznie przez SSH

Jedna komenda stawia aplikację i reverse proxy Caddy, który sam pobiera i odnawia
certyfikat HTTPS od Let's Encrypt.

### 1. Domena (`morphyhub.com` — DNS w Cloudflare)

Domena korzysta z nameserverów Cloudflare (`sonny.ns.cloudflare.com`,
`priscilla.ns.cloudflare.com`) i nie ma jeszcze rekordu A. W panelu Cloudflare
→ *DNS → Records* dodaj:

| Typ | Nazwa | Wartość | Proxy |
|---|---|---|---|
| A | `@` | IP Twojego VPS-a | **DNS only** (szara chmurka) |

> **Ustaw najpierw „DNS only”.** Przy włączonym proxy (pomarańczowa chmurka)
> Caddy nie dostanie certyfikatu Let's Encrypt, bo ruch na porcie 80 nie dociera
> bezpośrednio do serwera. Proxy możesz włączyć później — patrz sekcja
> *Cloudflare proxy* na końcu tego dokumentu.

Sprawdzenie propagacji:

```bash
dig +short morphyhub.com @1.1.1.1
```

Rekord dla `www` dodaj tylko przy wariancie C — tam Caddy czyta `deploy/Caddyfile`,
w którym jest przekierowanie `www` → domena główna. Warianty A i B obsługują samą
domenę główną, więc rekord `www` wskazywałby na serwer, który nie ma dla niego
certyfikatu.

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

### 4. Start

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
docker compose logs -f app
```

Nakładka `docker-compose.local.yml` jest tu istotna: buduje obraz z `Dockerfile`
zamiast pobierać go z GHCR i podstawia pełny `deploy/Caddyfile` (przekierowanie
`www`, nagłówki bezpieczeństwa, logi dostępu). Bez niej dostaniesz dokładnie tę
samą konfigurację, co przy deployu zarządzanym przez Hostingera.

Baza siedzi na nazwanym wolumenie Dockera, więc nie trzeba nic robić z uprawnieniami
katalogu na hoście ani pamiętać o `chown`.

Panel będzie pod `https://morphyhub.com`. Caddy wystawi certyfikat przy pierwszym
żądaniu — jeśli się nie pobiera, sprawdź, czy porty 80 i 443 są otwarte, czy rekord A
wskazuje na ten serwer i czy proxy Cloudflare jest wyłączone.

Podgląd postępu wystawiania certyfikatu:

```bash
docker compose logs -f caddy
```

### 5. Redirect URI w Google

W [Google Cloud Console](https://console.cloud.google.com/apis/credentials) dopisz
do swojego OAuth client ID oba adresy:

```
https://morphyhub.com/auth/callback
http://192.168.1.40:8006/auth/callback
```

Google pozwala na wiele adresów, więc panel będzie działał równolegle w domu
i na serwerze. Adresu z `www` nie trzeba dopisywać — logowanie zawsze startuje
z `BASE_URL`, czyli z wersji bez `www`.

Do listy **Authorized JavaScript origins** nie musisz nic dodawać — panel nie
uruchamia logowania po stronie przeglądarki.

### Aktualizacja po zmianach w repo

```bash
cd /opt/indexmenow
git pull
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

### Backup

Cała baza to jeden plik na wolumenie Dockera. Kopia:

```bash
docker compose stop app
docker compose cp app:/app/data ./backup-$(date +%F)
docker compose start app
```

---

## Wariant D — bez Dockera (systemd + nginx)

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
