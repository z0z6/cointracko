'use strict';
// Prosty, trwały magazyn danych w pliku JSON (zapis atomowy).
const fs = require('fs');
const path = require('path');
const { DEFAULT_SETTINGS, DEFAULT_DATA, sanitizeSettings, sanitizeData } = require('../renderer/core');

const clone = (o) => JSON.parse(JSON.stringify(o));
const { deepMerge: deepMergeSettings } = require('../renderer/core');

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch (_) { /* np. system plików bez uprawnień */ }
    this.file = path.join(dir, 'cointracko-dane.json');
    this.state = this._load();
    this.rev = 1; // licznik zmian – przeglądarka sprawdza go, żeby wiedzieć, kiedy odświeżyć dane
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const settings = sanitizeSettings(raw.settings); // nieznane i dawne klucze (np. import ze zrzutu, konto Claude) są odrzucane
      return { version: 1, settings, data: sanitizeData(raw.data) };
    } catch (e) {
      if (fs.existsSync(this.file)) {
        try { fs.copyFileSync(this.file, this.file + '.uszkodzony-' + Date.now()); } catch (_) { /* ignore */ }
      }
      return { version: 1, settings: clone(DEFAULT_SETTINGS), data: clone(DEFAULT_DATA) };
    }
  }

  save() {
    // zapis atomowy; plik z danymi (i opcjonalnym kluczem API) czytelny tylko dla właściciela
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get settings() { return this.state.settings; }
  get data() { return this.state.data; }

  updateSettings(patch) {
    this.state.settings = sanitizeSettings(deepMergeSettings(this.state.settings, patch));
    this.rev++;
    this.save();
    return this.state.settings;
  }

  setData(data) {
    this.state.data = sanitizeData(data);
    this.rev++;
    this.save();
    return true;
  }
}

module.exports = { Store };
