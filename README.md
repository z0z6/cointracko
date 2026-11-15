# CoinTracko

Notowania kryptowalut na żywo, portfel, alerty i wykresy – na Linuksa (AppImage) i Androida (APK), z jednego kodu.

## Co potrafi

- **Notowania na żywo** – po uruchomieniu aplikacja sama łączy się z siecią i odświeża dane (co 30 s – 5 min, do wyboru); przy braku połączenia ponawia próby i pokazuje ostatnie znane ceny.
- **Portfel i wpisy** – każda pozycja składa się z wpisów (zakup lub sprzedaż: data, ilość, cena). Posiadana ilość to zawsze suma wpisów, a każdy wpis – także dawny „bez daty” – można poprawić wprost na liście; wartość (USD / PLN / EUR) i suma na Pulpicie przeliczają się od razu. Cenę z wybranego dnia można pobrać jednym kliknięciem. Aplikacja liczy średnią cenę zakupu oraz zysk/stratę od zakupu do teraz – dla wpisu, pozycji i całego portfela.
- **Statystyki** – wykres kołowy struktury portfela, zainwestowana kwota, zysk niezrealizowany i zrealizowany, zmiany 1 h / 24 h / 7 dni, wartość portfela w czasie (z największym obsunięciem), koncentracja, najlepsze i najsłabsze pozycje, tabela wyników.
- **Eksport / import** – portfel (wpisy, obserwowane, alerty) zapisuje się do pliku `cointracko-portfel-RRRR-MM-DD.json`, który można wczytać na innym urządzeniu – ten sam plik działa na Linuksie i Androidzie.
- **Podgląd w przeglądarce** (Linux) – w Ustawieniach można udostępnić interfejs pod lokalnym adresem `http://127.0.0.1:47820/` (tylko ten komputer). Otworzysz go w Vivaldim, Chrome lub Edge, także jako panel boczny Vivaldiego; dane, wykresy i edycja synchronizują się z aplikacją. Alerty obsługuje okno aplikacji.
- **Ceny z wielu źródeł** – oprócz CoinGecko aplikacja pobiera cenę z trzech oracle (**Pyth Network**, **RedStone**, **Chainlink**) oraz z indeksu CryptoCompare i giełd Coinbase i Binance. Cena w aplikacji to średnia ze źródeł zgodnych ze sobą (tolerancja ±2%, do zmiany); źródło odbiegające od mediany jest odrzucane, a oracle ze starą wyceną pomijane. W widoku każdej kryptowaluty jest tabela porównawcza (cena, odchylenie, aktualność, status) z oceną zgodności. Źródła można włączać i wyłączać w Ustawieniach → Źródła i wiadomości.
- **Historia do 6 lat, co dzień** – wartość portfela w Statystykach i wykres każdej kryptowaluty sięgają 6 lat wstecz w rozdzielczości dziennej (CryptoCompare, zapas: Binance; dane zapisują się lokalnie, więc kolejne otwarcia są natychmiastowe). Wartość można liczyć „wg wpisów” (ilość posiadana danego dnia × cena z tego dnia) albo dla obecnych ilości.
- **Wiadomości i anomalie** – widok „Wiadomości” wyszukuje w internecie (Google News, CoinDesk, Cointelegraph, Decrypt, The Block) doniesienia o aktywach z portfela i obserwowanych, oznacza je jako pozytywne (bullish), negatywne (bearish) lub neutralne i wykrywa anomalie: włamania i ataki, nadużycia i oszustwa, problemy z płynnością i niewypłacalność, awarie sieci, wyprzedaż przez insiderów, plotki (także rozprzestrzeniające się w wielu serwisach) oraz sygnały rynkowe (gwałtowny ruch ceny, odklejenie stablecoina, rozbieżność źródeł cen). O poważnych anomaliach aplikacja powiadamia. **To heurystyka oparta na słowach kluczowych w nagłówkach – pomoc w przeglądzie, nie ocena prawdziwości ani porada inwestycyjna.**
- **Alerty** – cena powyżej/poniżej poziomu albo zmiana o zadany procent w 24 h; powiadomienia systemowe, alerty jednorazowe i powtarzalne.
- **Wykresy** – 24 h, 7 dni, 30 dni, 90 dni, 1 rok, 2 lata, 5 lat i 6 lat, z celownikiem pod kursorem; lista obserwowanych i ranking Top 100.
- **Linux** – okno w stylu macOS z przyciskami po prawej (minimalizuj, maksymalizuj, zamknij); zamknięcie okna chowa aplikację do zasobnika (lub minimalizuje na pasek zadań – do wyboru w Ustawieniach).
- **Autostart** (Linux) – domyślnie aplikacja uruchamia się razem z systemem (wpis `~/.config/autostart/cointracko.desktop`), od razu pobiera notowania i czeka w zasobniku; w Ustawieniach można to wyłączyć albo zostawić widoczne okno. Działa z AppImage i z paczką `.deb`.

Źródła danych: CoinGecko, Pyth Network (Hermes), RedStone, Chainlink (odczyt z kontraktu przez publiczny węzeł Ethereum), CryptoCompare, Coinbase, Binance, Google News oraz kanały RSS serwisów branżowych – wszystko publiczne API, bez kluczy.

## Kompilacja w GitHub Actions

Każdy push na `main` buduje oba pakiety (zakładka **Actions** → ostatnie uruchomienie → **Artifacts**):

| Artefakt | Zawartość |
|---|---|
| `CoinTracko-linux-AppImage` | `CoinTracko-<wersja>-linux-x86_64.AppImage` |
| `CoinTracko-android-apk` | `CoinTracko-<wersja>-android.apk` |

Tag `v*` (np. `v1.0.0`) dodatkowo publikuje oba pliki jako **Release**.

Uruchomienie na Linuksie: `chmod +x CoinTracko-*.AppImage && ./CoinTracko-*.AppImage`.
Na Androidzie: skopiuj plik APK na telefon i zainstaluj (trzeba zezwolić na instalację z nieznanych źródeł).

## Praca lokalna

```bash
npm install          # instaluje zależności i kopiuje czcionkę do src/renderer/vendor
npm start            # uruchamia aplikację (Electron)
npm test             # testy logiki
npm run dist:linux   # AppImage w dist/
npm run android:apk  # APK (wymaga Android SDK i JDK 21)
```

`COINTRACKO_MOCK=1 npm start` uruchamia aplikację na danych przykładowych (bez internetu).

## Budowa

- `src/renderer/` – cały interfejs i logika (czysty JS, bez bundlera); ten sam katalog działa w Electronie i w aplikacji na Androida (Capacitor).
  - `core.js` – logika wspólna (portfel, wpisy, alerty, statystyki, formatowanie), testowana w `test/run-tests.js`
  - `market.js` – klient CoinGecko, `chart.js` – wykresy, `platform.js` – różnice Electron / Android / przeglądarka
  - `oracles.js` – źródła cen i konsensus, `history.js` – historia dzienna, `intel.js` – wiadomości i anomalie, `cache.js` – pamięć podręczna (IndexedDB), `allowlist.js` – lista dozwolonych adresów, `extras.js` – widoki tych funkcji
- `src/main/` – proces główny Electrona (okno, zasobnik, powiadomienia, dane w pliku JSON, `web-server.js` – lokalny podgląd w przeglądarce)
- `android/` – projekt Android (Capacitor). Plik `android/app/cointracko.keystore` to stały klucz podpisu trzymany w repozytorium, dzięki czemu kolejne wersje APK instalują się jako aktualizacja. Do publikacji w sklepie użyj własnego klucza.

## Bezpieczeństwo i wydajność

- Zapytania sieciowe wykonuje proces główny przez jeden klient: tylko HTTPS, tylko adresy z listy dozwolonych (`allowlist.js`; węzły Ethereum – wyłącznie `eth_call`), przekierowania sprawdzane przed wysłaniem, limity czasu i rozmiaru odpowiedzi, wspólna pamięć podręczna, ograniczona liczba równoległych zapytań. Klucz CoinGecko trafia tylko do CoinGecko.
- Okno: `contextIsolation`, `sandbox`, brak `nodeIntegration`, ścisłe CSP, brak nawigacji i `<webview>`, odmowa wszystkich uprawnień, polecenia IPC tylko od okna aplikacji, walidacja i białe listy ustawień oraz danych (także z pliku importu i z przeglądarki), ochrona przed zatruciem prototypu; w spakowanej wersji wyłączone narzędzia deweloperskie, tryb zrzutów i dane przykładowe. Binarka Electrona ma wyłączone `RunAsNode`, `NODE_OPTIONS` i `--inspect`, a kod ładuje się tylko z archiwum asar.
- Podgląd w przeglądarce: tylko `127.0.0.1`, domyślnie wyłączony, sprawdzanie `Host`/`Origin`/`Sec-Fetch-Site`, nagłówek wymagany przy zapisie, nagłówki bezpieczeństwa i limity połączeń. Ma dostęp do niego każdy program uruchomiony na tym komputerze – włączaj go tylko na swoim koncie.
- Plik z danymi ma uprawnienia `0600` (katalog `0700`). Android: bez kopii zapasowej, bez ruchu jawnego, bez zaufania do certyfikatów użytkownika.
- Wydajność: wspólna pamięć podręczna i łączenie identycznych zapytań, ceny z oracle pobierane równolegle z notowaniami, historia 6 lat pobierana raz i dopisywana przyrostowo, wyłączony proces GPU (mniej pamięci), wiadomości co 20 min.
- CI: uprawnienia tylko do odczytu (zapis tylko w zadaniu wydania), `npm audit` zależności produkcyjnych, Dependabot. Opcjonalny własny klucz podpisu APK: sekrety `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (zmiana klucza wymaga jednorazowej deinstalacji poprzedniej wersji).

Dane (portfel, obserwowane, alerty) są zapisywane wyłącznie na urządzeniu. Notowania mają charakter informacyjny i nie stanowią porady inwestycyjnej.
