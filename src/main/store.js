'use strict';
// Prosty, trwały magazyn danych w pliku JSON (zapis atomowy).
const fs = require('fs');
const path = require('path');
const { DEFAULT_SETTINGS, DEFAULT_DATA, deepMerge, sanitizeData } = require('../renderer/core');

const clone = (o) => JSON.parse(JSON.stringify(o));

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'cointracko-dane.json');
    this.state = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { version: 1, settings: deepMerge(DEFAULT_SETTINGS, raw.settings || {}), data: sanitizeData(raw.data) };
    } catch (e) {
      if (fs.existsSync(this.file)) {
        try { fs.copyFileSync(this.file, this.file + '.uszkodzony-' + Date.now()); } catch (_) { /* ignore */ }
      }
      return { version: 1, settings: clone(DEFAULT_SETTINGS), data: clone(DEFAULT_DATA) };
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  get settings() { return this.state.settings; }
  get data() { return this.state.data; }

  updateSettings(patch) {
    this.state.settings = deepMerge(this.state.settings, patch);
    this.save();
    return this.state.settings;
  }

  setData(data) {
    this.state.data = sanitizeData(data);
    this.save();
    return true;
  }
}

module.exports = { Store };
