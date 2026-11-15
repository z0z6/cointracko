# CoinTracko

Notowania kryptowalut na żywo, portfel, alerty i wykresy – na Linuksa (AppImage) i Androida (APK), z jednego kodu.

## Co potrafi

- **Notowania na żywo** – po uruchomieniu aplikacja sama łączy się z siecią i odświeża dane (co 30 s – 5 min, do wyboru); przy braku połączenia ponawia próby i pokazuje ostatnie znane ceny.
- **Portfel i wpisy** – każda pozycja składa się z wpisów (zakup lub sprzedaż: data, ilość, cena). Posiadana ilość to zawsze suma wpisów, a każdy wpis – także dawny „bez daty” – można poprawić wprost na liście; wartość (USD / PLN / EUR) i suma na Pulpicie przeliczają się od razu. Cenę z wybranego dnia można pobrać jednym kliknięciem. Aplikacja liczy średnią cenę zakupu oraz zysk/stratę od zakupu do teraz – dla wpisu, pozycji i całego portfela.
- **Statystyki** – wykres kołowy struktury portfela, zainwestowana kwota, zysk niezrealizowany i zrealizowany, zmiany 1 h / 24 h / 7 dni, wartość portfela w czasie (z największym obsunięciem), koncentracja, najlepsze i najsłabsze pozycje, tabela wyników.
- **Eksport / import** – portfel (wpisy, obserwowane, alerty) zapisuje się do pliku `cointracko-portfel-RRRR-MM-DD.json`, który można wczytać na innym urządzeniu – ten sam plik działa na Linuksie i Androidzie.
- **Podgląd w przeglądarce** (Linux) – w Ustawieniach można udostępnić interfejs pod lokalnym adresem `http://127.0.0.1:47820/` (tylko ten komputer). Otworzysz go w Vivaldim, Chrome lub Edge, także jako panel boczny Vivaldiego; dane, wykresy i edycja synchronizują się z aplikacją. Alerty obsługuje okno aplikacji.
- **Alerty** – cena powyżej/poniżej poziomu albo zmiana o zadany procent w 24 h; powiadomienia systemowe, alerty jednorazowe i powtarzalne.
- **Wykresy** – 24 h, 7 dni, 30 dni, 90 dni, 1 rok, z celownikiem pod kursorem; lista obserwowanych i ranking Top 100.
- **Linux** – okno w stylu macOS z przyciskami po prawej (minimalizuj, maksymalizuj, zamknij); zamknięcie okna chowa aplikację do zasobnika (lub minimalizuje na pasek zadań – do wyboru w Ustawieniach).
- **Autostart** (Linux) – domyślnie aplikacja uruchamia się razem z systemem (wpis `~/.config/autostart/cointracko.desktop`), od razu pobiera notowania i czeka w zasobniku; w Ustawieniach można to wyłączyć albo zostawić widoczne okno. Działa z AppImage i z paczką `.deb`.

Źródło notowań: [CoinGecko](https://www.coingecko.com) (publiczne API, klucz niewymagany).

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
- `src/main/` – proces główny Electrona (okno, zasobnik, powiadomienia, dane w pliku JSON, `web-server.js` – lokalny podgląd w przeglądarce)
- `android/` – projekt Android (Capacitor). Plik `android/app/cointracko.keystore` to stały klucz podpisu trzymany w repozytorium, dzięki czemu kolejne wersje APK instalują się jako aktualizacja. Do publikacji w sklepie użyj własnego klucza.

Dane (portfel, obserwowane, alerty) są zapisywane wyłącznie na urządzeniu. Notowania mają charakter informacyjny i nie stanowią porady inwestycyjnej.
