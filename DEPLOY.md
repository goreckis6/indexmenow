# Deploy na Hostingerze (Node.js Web App)

Panel jest aplikacją **Express (Node.js) + MySQL**. Pasuje do kreatora
**Websites → Add Website → Node.js web app** („Deploy Your Web App”).

| Plan | Czy zadziała |
|---|---|
| **Business / Cloud Hosting** (Node.js Web App) | ✅ tak — to domyślna ścieżka |
| **VPS** | ✅ tak — Docker (patrz dół dokumentu) albo Node ręcznie |
| Web Hosting bez Node | ❌ nie |

---

## 1. Baza MySQL

W hPanel → **Databases → MySQL** utwórz bazę i użytkownika z pełnymi prawami.
Zapisz: host, port, nazwę bazy, użytkownika, hasło.

Schemat tabel tworzy się sam przy pierwszym starcie aplikacji (`migrate`).

---

## 2. Deploy z GitHuba

1. hPanel → **Websites → Add Website → Node.js web app**
2. **Import Git repository** → wybierz `goreckis6/indexmenow` (branch `main`)
3. Ustawienia buildu (kreator zwykle wykryje je z `package.json`):

| Pole | Wartość |
|---|---|
| Framework | **Express** |
| Node.js | **22** (wymagane) |
| Root directory | `./` (puste) |
| Build command / script | `build` (może zostać — trzyma `dist/` jako zapas) |
| Output directory | **puste** (nie wpisuj `dist`) |
| Entry file | **`server.js`** (NIE `app.js`, NIE `dist/server.js`) |
| Start | `npm start` (= `node server.js` → ESM `dist/server.js`) |

> Projekt jest **ESM** (`"type": "module"`). Nie używamy `tsx` na Hostingerze —
> ich sandbox blokuje binarkę esbuild (`EACCES`). Start to czysty `node`.

Jeśli po zielonym buildzie nadal widzisz 503 CDN Hostingera:
1. **Entry file = `server.js`**, Output directory puste → Save → Redeploy.
2. Runtime logs: szukaj `[boot] listening`.
3. `/healthz` — nawet bez MySQL powinien zwrócić JSON (`booting` / `misconfigured` / `ok`).

4. Wklej zmienne środowiskowe (poniżej) i kliknij **Deploy**.

Po każdym pushu na `main` Hostinger przebuduje aplikację automatycznie
(na planach Business/Cloud z włączonym auto-redeploy).

---

## 3. Zmienne środowiskowe

### Wymagane

```
BASE_URL=https://morphyhub.com
SECRET_KEY=TUTAJ_WYNIK_openssl_rand_base64_48
GOOGLE_CLIENT_ID=TUTAJ_CLIENT_ID
GOOGLE_CLIENT_SECRET=TUTAJ_CLIENT_SECRET
DB_HOST=localhost
DB_PORT=3306
DB_USER=TUTAJ_USER_MYSQL
DB_PASSWORD=TUTAJ_HASLO_MYSQL
DB_NAME=TUTAJ_NAZWA_BAZY
```

Na Hostingerze `DB_HOST` bywa `localhost` albo adres typu `mysql.hostinger.com`
— skopiuj dokładnie to, co pokazuje panel baz.

`BASE_URL` **musi być `https://...`** i identyczny z redirect URI w Google
(`https://morphyhub.com/auth/callback`).

Wygenerowanie sekretu:

```bash
openssl rand -base64 48
```

albo lokalnie:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Zalecane

```
ALLOWED_EMAILS=slavomir.gorecki@gmail.com
TIMEZONE=Europe/Warsaw
SCHEDULER_ENABLED=true
```

### Opcjonalne

`AUTO_INDEX_HOUR` (3), `DEFAULT_DAILY_QUOTA` (200), `SITEMAP_SCAN_INTERVAL_HOURS` (12),
`INSPECTION_BATCH_SIZE` (50), `API_THROTTLE_SECONDS` (0.6), `RECHECK_AFTER_DAYS` (7),
`LOG_LEVEL` (INFO).

`PORT` i `HOST` ustawia Hostinger — nie nadpisuj ich, chyba że wiesz, co robisz.

---

## 4. Google OAuth

W [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
dopisz do OAuth client ID:

```
https://morphyhub.com/auth/callback
```

(opcjonalnie lokalny: `http://192.168.1.40:8006/auth/callback`)

Włącz API: **Google Search Console API** oraz **Web Search Indexing API**.

---

## 5. DNS (`morphyhub.com` — Cloudflare)

| Typ | Nazwa | Wartość | Proxy |
|---|---|---|---|
| A / CNAME | `@` | wg Hostingera | możesz włączyć proxy (orange) |
| A / CNAME | `www` | wg Hostingera | j.w. |

Przy Hostinger Node.js certyfikat wystawia Hostinger / Cloudflare — **nie** Caddy.
Jeśli Cloudflare proxy jest włączone, SSL ustaw na **Full** albo **Full (strict)**.

---

## Harmonogram na hostingu współdzielonym

Auto-indeksowanie o 3:00 i skan sitemap działają w procesie Node. Na managed
hostingu Hostinger może:

- trzymać **kilka instancji** naraz — blokada w tabeli `scheduler_lock` pilnuje,
  żeby cykliczne zadania wykonywała tylko jedna,
- **uśpić** proces przy braku ruchu — wtedy zadania odpalą się dopiero po
  pierwszym wejściu na panel następnego dnia.

Jeśli auto-indeksowanie jest krytyczne, rozważ VPS albo zewnętrzny cron wołający
endpoint (na razie panel nie eksponuje chronionego cron URL — wtedy zostaje VPS).

Żeby wyłączyć scheduler i zglaszac tylko ręcznie:

```
SCHEDULER_ENABLED=false
```

---

## Lokalny start (Node)

```powershell
cp .env.example .env
# uzupelnij MySQL + Google OAuth
npm install
npm run migrate
npm run dev
```

Panel: `http://localhost:8006` (albo `BASE_URL` z `.env`).

Smoke test na prawdziwej bazie:

```powershell
npm run smoke
```

---

## Alternatywa: VPS + Docker

Katalog `docker-compose.yml` / `Dockerfile` oraz workflow `.github/workflows/deploy.yml`
nadal służą do wdrożenia kontenerowego na VPS (obraz Pythonowy / starsza ścieżka).
Po migracji na Node preferuj kreator **Node.js web app** powyżej — nie wymaga VPS-a.

Jeśli zostajesz przy Dockerze na VPS, pamiętaj: obecny `docker-compose.yml` buduje
jeszcze obraz z `Dockerfile` Pythona. Do czasu aktualizacji obrazu używaj Node Web App
albo ręcznego `npm start` na VPS z zainstalowanym Node 20+.
