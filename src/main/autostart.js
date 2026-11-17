'use strict';
// Uruchamianie razem z systemem. Linux: wpis XDG w ~/.config/autostart (działa w GNOME, KDE, XFCE, Cinnamon…);
// Windows i macOS: mechanizm systemu przez Electrona.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = 'cointracko.desktop';

// Polecenie uruchamiające aplikację: AppImage (ścieżka pliku), zainstalowana paczka (skrypt startowy obok
// pliku .bin – dodaje --no-sandbox) albo bieżący program.
function execPath(env, processExecPath) {
  if (env.APPIMAGE) return env.APPIMAGE;
  return processExecPath.endsWith('.bin') ? processExecPath.slice(0, -4) : processExecPath;
}

// Wartość pola Exec zgodnie ze specyfikacją XDG: cudzysłów wokół ścieżki, znaki specjalne z ucieczką.
function quoteExec(p) {
  return '"' + String(p).replace(/(["`$\\])/g, '\\$1') + '"';
}

function desktopEntry({ exe, hidden }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=CoinTracko',
    'Comment=Notowania kryptowalut na żywo',
    `Exec=${quoteExec(exe)}${hidden ? ' --hidden' : ''}`,
    'Icon=cointracko',
    'Terminal=false',
    'Categories=Finance;',
    'X-GNOME-Autostart-enabled=true',
    'X-GNOME-Autostart-Delay=8', // chwila na uruchomienie sieci i zasobnika po zalogowaniu
    ''
  ].join('\n');
}

function autostartDir(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
}

// Zapisuje lub usuwa wpis autostartu na Linuksie. Zwraca ścieżkę pliku (albo null po usunięciu).
function setLinuxAutostart(enabled, { exe, hidden, dir }) {
  const file = path.join(dir, FILE);
  if (!enabled) { try { fs.unlinkSync(file); } catch (_) { /* nie było */ } return null; }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, desktopEntry({ exe, hidden }), { mode: 0o644 });
  return file;
}

// Stosuje ustawienia { autostart, startHidden } w bieżącym systemie.
function apply(app, win, { packaged = app.isPackaged } = {}) {
  const enabled = !!win.autostart;
  const hidden = win.startHidden !== false;
  if (process.platform === 'linux') {
    if (!packaged && enabled) throw new Error('Autostart działa w zainstalowanej aplikacji (AppImage lub .deb), nie w trybie deweloperskim.');
    return setLinuxAutostart(enabled, { exe: execPath(process.env, process.execPath), hidden, dir: autostartDir() });
  }
  // Windows, wersja przenośna (.exe): process.execPath wskazuje tymczasowy katalog rozpakowania – autostart musi wskazywać sam plik .exe.
  const opts = { openAtLogin: enabled, args: hidden ? ['--hidden'] : [] };
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE) opts.path = process.env.PORTABLE_EXECUTABLE_FILE;
  app.setLoginItemSettings(opts);
  return null;
}

module.exports = { execPath, quoteExec, desktopEntry, autostartDir, setLinuxAutostart, apply };
