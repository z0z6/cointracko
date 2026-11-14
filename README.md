# CoinTracko

Notowania kryptowalut na żywo, portfel, alerty i wykresy – na Linuksa (AppImage) i Androida (APK), z jednego kodu.

## Co potrafi

- **Notowania na żywo** – po uruchomieniu aplikacja sama łączy się z siecią i odświeża dane (co 30 s – 5 min, do wyboru); przy braku połączenia ponawia próby i pokazuje ostatnie znane ceny.
- **Portfel** – ilości posiadanych tokenów edytujesz ręcznie, a wartość (USD / PLN / EUR) przelicza się przy każdej aktualizacji.
- **Wczytywanie zrzutu ekranu** – zrzut z giełdy lub portfela (plik, przeciągnięcie, Ctrl+V) → aplikacja odczytuje tokeny i ilości, dodaje je do obserwowanych i wycenia. Odczyt przez Claude (konto Claude na komputerze albo klucz API) lub lokalnie przez OCR, bez wysyłania obrazu.
- **Alerty** – cena powyżej/poniżej poziomu albo zmiana o zadany procent w 24 h; powiadomienia systemowe, alerty jednorazowe i powtarzalne.
- **Wykresy** – 24 h, 7 dni, 30 dni, 90 dni, 1 rok, z celownikiem pod kursorem; lista obserwowanych i ranking Top 100.
- **Linux** – okno w stylu macOS z przyciskami po prawej (minimalizuj, maksymalizuj, zamknij); zamknięcie okna chowa aplikację do zasobnika (lub minimalizuje na pasek zadań – do wyboru w Ustawieniach).

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
npm install          # instaluje zależności i kopiuje czcionkę oraz silnik OCR do src/renderer/vendor
npm start            # uruchamia aplikację (Electron)
npm test             # testy logiki
npm run dist:linux   # AppImage w dist/
npm run android:apk  # APK (wymaga Android SDK i JDK 21)
```

`COINTRACKO_MOCK=1 npm start` uruchamia aplikację na danych przykładowych (bez internetu).

## Budowa

- `src/renderer/` – cały interfejs i logika (czysty JS, bez bundlera); ten sam katalog działa w Electronie i w aplikacji na Androida (Capacitor).
  - `core.js` – logika wspólna (portfel, alerty, czytanie zrzutów, formatowanie), testowana w `test/run-tests.js`
  - `market.js` – klient CoinGecko, `chart.js` – wykresy, `ocr.js` – lokalny OCR (Tesseract), `platform.js` – różnice Electron/Android
- `src/main/` – proces główny Electrona (okno, zasobnik, powiadomienia, dane w pliku JSON, połączenie z kontem Claude przez Claude Code)
- `android/` – projekt Android (Capacitor). Plik `android/app/cointracko.keystore` to stały klucz podpisu trzymany w repozytorium, dzięki czemu kolejne wersje APK instalują się jako aktualizacja. Do publikacji w sklepie użyj własnego klucza.

Dane (portfel, obserwowane, alerty) są zapisywane wyłącznie na urządzeniu. Notowania mają charakter informacyjny i nie stanowią porady inwestycyjnej.
