# IndexMeNow

Panel do przyspieszania indeksowania stron w wyszukiwarkach. Logowanie kontem Google,
integracja z Google Search Console, Google Indexing API oraz IndexNow (Bing, Yandex,
Seznam, Naver).

**Stack produkcyjny:** Node.js (Express) + MySQL + Nunjucks.  
Dane w MySQL, tokeny Google szyfrowane AES-256-GCM, deploy na Hostingerze przez
**Node.js Web App** (push na GitHub).

> Deploy opisuje **[DEPLOY.md](DEPLOY.md)**.

Katalog `app/` to wcześniejsza wersja w Pythonie (FastAPI + SQLite) — nie jest używana
przez `npm start`. Aktywny kod leży w `src/`, szablony w `views/`, statyki w `public/`.

---

## Szybki start (Node)

```powershell
cd C:\Users\admin_test\indexmeplease
cp .env.example .env
# uzupelnij DB_* oraz GOOGLE_CLIENT_*
npm install
npm run migrate
npm run dev
```

Panel: adres z `BASE_URL` (domyślnie `http://localhost:8006`).

---

## Co potrafi


| Funkcja | Opis |
|---|---|
| Logowanie Google | OAuth 2.0, konto Gmail powiązane z Search Console |
| Import stron | Jednym kliknięciem pobiera wszystkie właściwości z Search Console |
| Sitemapy | Synchronizacja z GSC, auto-wykrywanie, zgłaszanie, usuwanie, skan URL-i (także indeksy sitemap i `.gz`) |
| Inspekcja URL | URL Inspection API — realny status indeksowania, canonical, robots, data ostatniego crawla |
| Zgłaszanie do Google | Indexing API, pojedynczo i masowo, z pilnowaniem dziennego limitu |
| IndexNow | Bing, Yandex, Seznam i Naver jednym zgłoszeniem, z generatorem pliku klucza |
| Auto-indeksowanie | Codzienny przebieg: skan sitemap → inspekcja → zgłoszenie tego, czego brakuje |
| Historia i wykresy | Pełny dziennik zadań, pokrycie indeksem w czasie, wykorzystanie limitu |
| Narzędzia SEO | Podgląd SERP i Open Graph, diagnostyka meta tagów, przeglądarka sitemap |
| Eksport | CSV ze statusem każdego adresu |
| Wiele workspace'ów | Osobne pule stron i limitów, np. per klient |

---

## Szybki start (Windows)

```powershell
cd C:\Users\admin_test\indexmeplease
.\start.ps1
```

Skrypt utworzy `.venv`, zainstaluje zależności, wygeneruje `.env` i uruchomi panel.
Zanim się zalogujesz, musisz jeszcze wykonać **konfigurację Google** (poniżej).

Ręcznie:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe run.py
```

### Podgląd bez konfiguracji

Chcesz najpierw zobaczyć interfejs? Tryb demo tworzy przykładowe dane i pomija logowanie:

```powershell
.\.venv\Scripts\python.exe demo.py
```

Panel demo: <http://127.0.0.1:8007>. Używa osobnej bazy `data/demo.db` i nie rusza
Twoich prawdziwych danych. Nie zostawiaj go uruchomionego na stałe — nie ma logowania.

---

## Konfiguracja Google (jednorazowo, ~10 minut)

### 1. Projekt i włączenie API

1. Wejdź na <https://console.cloud.google.com/> i utwórz projekt (np. `indexmeplease`).
2. Włącz dwa API:
   - [Google Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com)
   - [Web Search Indexing API](https://console.cloud.google.com/apis/library/indexing.googleapis.com)

### 2. Ekran zgody OAuth

1. **APIs & Services → OAuth consent screen**.
2. Typ **External**, wypełnij nazwę aplikacji i e-mail kontaktowy.
3. W sekcji **Test users** dodaj swój adres Gmail (aplikacja zostaje w trybie testowym —
   to wystarczy do użytku własnego; token odświeżający wygasa wtedy po 7 dniach,
   więc raz w tygodniu klikniesz ponownie „Zaloguj”. Publikacja aplikacji usuwa ten limit).
4. Dodaj zakresy (scopes):
   - `https://www.googleapis.com/auth/webmasters`
   - `https://www.googleapis.com/auth/indexing`

### 3. Dane logowania

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Typ: **Web application**.
3. **Authorized redirect URIs** — wpisz dokładnie adres, pod którym będziesz otwierał panel,
   z dopiskiem `/auth/callback`:

   ```
   http://192.168.1.50:8006/auth/callback
   ```

   Jeśli będziesz wchodzić z kilku adresów, dodaj każdy osobno, np.:

   ```
   http://192.168.1.50:8006/auth/callback
   http://127.0.0.1:8006/auth/callback
   http://localhost:8006/auth/callback
   ```

4. Skopiuj **Client ID** i **Client secret** do pliku `.env`:

   ```ini
   GOOGLE_CLIENT_ID=123456789-xxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxx
   BASE_URL=http://192.168.1.50:8006
   ```

   > `BASE_URL` musi być **identyczny** z adresem redirect URI (bez `/auth/callback`).
   > Przy niezgodności Google pokaże błąd `redirect_uri_mismatch`.

5. Zrestartuj panel i zaloguj się.

### 4. Uprawnienia w Search Console

Konto, którym się logujesz, musi mieć w Search Console rolę **Właściciel** (owner)
dla każdej strony. Rola „Pełny użytkownik” wystarcza do inspekcji URL-i, ale
**nie pozwala** korzystać z Indexing API.

---

## Dostęp z sieci domowej

W `.env`:

```ini
HOST=0.0.0.0
PORT=8006
BASE_URL=http://192.168.1.50:8006
```

`HOST=0.0.0.0` sprawia, że panel odpowiada na wszystkich interfejsach. Musisz jeszcze
otworzyć port w zaporze Windows:

```powershell
.\start.ps1 -Firewall     # uruchom PowerShell jako administrator
```

lub ręcznie:

```powershell
New-NetFirewallRule -DisplayName "IndexMePlease (8006)" -Direction Inbound `
  -Protocol TCP -LocalPort 8006 -Action Allow -Profile Private
```

**Stały adres IP.** Żeby adres się nie zmieniał, ustaw rezerwację DHCP na routerze
dla tego komputera albo przypisz statyczne IP w ustawieniach karty sieciowej.
Aktualny adres tego komputera to `192.168.1.40` — po zmianie na `192.168.1.50`
zaktualizuj `BASE_URL` w `.env` **oraz** redirect URI w Google Cloud Console.

**Ograniczenie dostępu.** Domyślnie zalogować się może każde konto Google.
Żeby wpuścić tylko siebie, w `.env`:

```ini
ALLOWED_EMAILS=twoj.adres@gmail.com,drugi.adres@gmail.com
```

---

## Jak używać

1. **Strony → Importuj z GSC** — panel pobiera wszystkie zweryfikowane właściwości.
2. Wejdź w stronę → zakładka **Sitemapy** → *Wykryj automatycznie* lub dodaj adres ręcznie,
   potem *Skanuj wszystkie sitemapy* (pobiera adresy do panelu).
3. Zakładka **Adresy URL** → *Sprawdz 50 URL-i w Google* — inspekcja pokaże, co nie jest w indeksie.
4. **Uruchom indeksowanie** — zgłasza niezaindeksowane adresy przez Indexing API.
5. W **Ustawieniach strony** włącz **Auto-indeksowanie** — od tej pory panel robi to sam
   codziennie o godzinie z `AUTO_INDEX_HOUR`.

Kolejność zgłaszania: najpierw adresy z wysokim priorytetem, potem potwierdzone
`NOT_INDEXED`, na końcu jeszcze niesprawdzone. Adresy już zaindeksowane są pomijane,
żeby nie marnować limitu.

---

## Limity

| API | Limit | Uwagi |
|---|---|---|
| Indexing API | 200 URL/dzień na projekt Google Cloud | Liczony przez panel; nadwyżka trafia do statusu „Pominięty” |
| URL Inspection API | 2000 zapytań/dzień na właściwość | Panel dławi zapytania (`API_THROTTLE_SECONDS`) |
| IndexNow | bez limitu | Wymaga pliku z kluczem na serwerze |

**Zwiększanie limitu Indexing API.** Dodaj konto serwisowe (Ustawienia → Konta serwisowe):

1. Google Cloud Console → **IAM & Admin → Service Accounts → Create**.
2. Wygeneruj klucz **JSON** i wgraj go w panelu.
3. W Search Console → *Ustawienia → Użytkownicy i uprawnienia* dodaj adres konta
   serwisowego (`...@....iam.gserviceaccount.com`) jako **Właściciela** każdej strony.

Każde konto serwisowe w osobnym projekcie Google Cloud = kolejne 200 zgłoszeń dziennie.
Panel automatycznie używa konta serwisowego, gdy jest dostępne, a w przeciwnym razie
tokena Twojego konta.

---

## IndexNow (Bing, Yandex, Seznam, Naver)

1. Ustawienia strony → włącz **IndexNow**.
2. Pobierz plik z kluczem i wgraj go do katalogu głównego strony, tak aby
   `https://twojastrona.pl/<klucz>.txt` zwracał sam klucz.
3. Od teraz każde zgłoszenie idzie równolegle do Google i do IndexNow.

---

## Konfiguracja (`.env`)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `HOST` | `0.0.0.0` | Interfejs nasłuchiwania |
| `PORT` | `8006` | Port panelu |
| `BASE_URL` | — | Publiczny adres panelu; musi zgadzać się z redirect URI |
| `SECRET_KEY` | — | Klucz sesji i szyfrowania tokenów. Zmiana = wylogowanie i utrata zapisanych tokenów |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Dane OAuth |
| `ALLOWED_EMAILS` | puste | Biała lista adresów e-mail (puste = każdy) |
| `DATABASE_URL` | `sqlite:///./data/indexmeplease.db` | Ścieżka bazy |
| `DEFAULT_DAILY_QUOTA` | `200` | Domyślny limit dzienny nowego workspace |
| `SITEMAP_SCAN_INTERVAL_HOURS` | `12` | Co ile godzin skanować sitemapy |
| `AUTO_INDEX_HOUR` | `3` | Godzina codziennego auto-indeksowania |
| `INSPECTION_BATCH_SIZE` | `50` | Ile URL-i sprawdzać w jednym przebiegu |
| `API_THROTTLE_SECONDS` | `0.6` | Odstęp między zapytaniami do API |
| `RECHECK_AFTER_DAYS` | `7` | Po ilu dniach ponawiać inspekcję |
| `TIMEZONE` | `Europe/Warsaw` | Strefa czasowa harmonogramu |

Po zmianie `.env` zrestartuj aplikację.

---

## Struktura projektu

```
indexmeplease/
├── app/
│   ├── main.py              # aplikacja FastAPI, middleware, obsługa błędów
│   ├── config.py            # ustawienia z .env
│   ├── database.py          # silnik SQLite (WAL) i sesje
│   ├── models.py            # tabele: users, sites, urls, sitemaps, jobs, quota, stats
│   ├── security.py          # szyfrowanie tokenów (Fernet), klucze IndexNow
│   ├── deps.py              # zależności FastAPI, sesja użytkownika, flash messages
│   ├── templating.py        # Jinja2 + filtry (daty, statusy, liczby)
│   ├── google/              # klienci API: oauth, search_console, indexing,
│   │                        #   indexnow, service_account
│   ├── services/            # logika: sites, sitemaps, urls, indexer, quota,
│   │                        #   stats, scheduler, tasks, seo_tools
│   ├── routers/             # widoki HTTP i JSON API
│   ├── templates/           # szablony Jinja2
│   └── static/              # CSS, JS, ikony (bez zależności zewnętrznych)
├── tests/test_smoke.py      # testy dymne wszystkich widoków
├── run.py                   # start produkcyjny
├── demo.py                  # tryb demo z przykładowymi danymi
├── start.ps1                # instalacja + start (Windows)
└── data/                    # baza SQLite (tworzona automatycznie)
```

Testy:

```powershell
.\.venv\Scripts\python.exe tests\test_smoke.py
```

Dokumentacja API JSON: <http://127.0.0.1:8006/api/docs>

---

## Rozwiązywanie problemów

**`redirect_uri_mismatch`** — adres w przeglądarce różni się od redirect URI w Google Cloud.
Sprawdź, czy `BASE_URL` w `.env` to dokładnie ten sam adres (protokół, IP, port), pod którym
otwierasz panel.

**`Permission denied. Failed to verify the URL ownership.`** — konto nie jest właścicielem
właściwości w Search Console. Dodaj je jako **Owner** (nie „Full user”).

**`Quota exceeded`** — wyczerpany limit 200 zgłoszeń dziennie. Poczekaj do północy
(czas pacyficzny) albo dodaj konto serwisowe w kolejnym projekcie Google Cloud.

**Panel niedostępny z innego urządzenia** — sprawdź `HOST=0.0.0.0`, regułę zapory
(`.\start.ps1 -Firewall`) i czy oba urządzenia są w tej samej sieci.

**Trzeba logować się co tydzień** — aplikacja OAuth jest w trybie „Testing”; refresh token
wygasa po 7 dniach. Opublikuj aplikację w OAuth consent screen, żeby to wyłączyć.

**Zgłoszony URL nadal nie jest w indeksie** — zgłoszenie przyspiesza wizytę robota, ale nie
gwarantuje indeksacji. Sprawdź stronę w narzędziu *Podgląd SEO*: kod 200, brak `noindex`,
poprawny canonical, unikalna treść i linki wewnętrzne.

---

## Bezpieczeństwo

- Tokeny Google są szyfrowane (Fernet, klucz pochodny od `SECRET_KEY`) — w bazie nie
  ma ich w postaci jawnej.
- Sesje w podpisanym ciasteczku, ważne 30 dni.
- Panel wysyła nagłówek `noindex` i nie ma publicznej rejestracji.
- Przeznaczony do sieci lokalnej. Jeśli chcesz wystawić go do internetu, postaw przed
  nim reverse proxy z HTTPS (Caddy / nginx), ustaw `BASE_URL` na adres `https://`
  i koniecznie uzupełnij `ALLOWED_EMAILS`.
