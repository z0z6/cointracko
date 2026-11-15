'use strict';
// Linux: część dystrybucji (np. Ubuntu 24.04) blokuje piaskownicę Chromium w AppImage
// („The SUID sandbox helper binary was found, but is not configured correctly”).
// Podmieniamy plik wykonywalny na skrypt, który uruchamia aplikację z --no-sandbox.
// Aplikacja wczytuje wyłącznie lokalne pliki (bez treści z internetu w oknie).
//
// Przed podmianą wzmacniamy też samą binarkę Electrona („fuses”): wyłączamy tryb Node.js przez ELECTRON_RUN_AS_NODE,
// zmienną NODE_OPTIONS oraz flagi debugowania (--inspect), a kod aplikacji wczytujemy wyłącznie z archiwum asar.
const fs = require('fs');
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const exe = context.packager.executableName;
  const dir = context.appOutDir;
  const bin = path.join(dir, exe);
  const real = path.join(dir, exe + '.bin');
  if (!fs.existsSync(bin) || fs.existsSync(real)) return;
  await flipFuses(bin, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true
  });
  fs.renameSync(bin, real);
  fs.writeFileSync(bin, `#!/bin/bash\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/${exe}.bin" --no-sandbox "$@"\n`, { mode: 0o755 });
};
