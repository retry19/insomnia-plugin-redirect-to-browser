'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { CdpClient } = require('./cdp');

const CANDIDATES = {
  linux: [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'microsoft-edge-stable',
    'brave-browser',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  win32: [
    ['PROGRAMFILES', 'Google/Chrome/Application/chrome.exe'],
    ['PROGRAMFILES(X86)', 'Google/Chrome/Application/chrome.exe'],
    ['LOCALAPPDATA', 'Google/Chrome/Application/chrome.exe'],
    ['PROGRAMFILES(X86)', 'Microsoft/Edge/Application/msedge.exe'],
    ['PROGRAMFILES', 'Microsoft/Edge/Application/msedge.exe'],
    ['PROGRAMFILES', 'BraveSoftware/Brave-Browser/Application/brave.exe'],
  ],
};

function isExecutable(file) {
  try {
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, name))) {
      return path.join(dir, name);
    }
  }
  return null;
}

const CHROMIUM_NAME = /chrom|msedge|edge|brave|vivaldi|opera/i;

function resolveExecutable(file) {
  if (!file) return null;
  if (path.isAbsolute(file)) return isExecutable(file) ? file : null;
  return findOnPath(file);
}

// Splits a .desktop Exec= line or a registry command into its executable,
// ignoring field codes such as %U and "%1".
function firstToken(command) {
  const m = String(command).trim().match(/^"([^"]+)"|^(\S+)/);
  return m ? m[1] || m[2] : null;
}

function linuxDefaultBrowser() {
  let desktopFile;
  try {
    desktopFile = execFileSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch (_) {
    return null;
  }
  if (!desktopFile) return null;

  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':');
  for (const dir of [dataHome, ...dataDirs, '/var/lib/snapd/desktop', '/var/lib/flatpak/exports/share']) {
    try {
      const content = fs.readFileSync(path.join(dir, 'applications', desktopFile), 'utf8');
      const exec = content.match(/^Exec=(.*)$/m);
      if (exec) return resolveExecutable(firstToken(exec[1]));
    } catch (_) {
      // Tries the next data directory.
    }
  }
  return null;
}

function windowsDefaultBrowser() {
  const query = (key, value) => {
    const out = execFileSync('reg', ['query', key, ...(value ? ['/v', value] : ['/ve'])], {
      encoding: 'utf8',
      timeout: 2000,
    });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.*)/);
    return m ? m[1].trim() : null;
  };
  try {
    const progId = query(
      'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
      'ProgId',
    );
    return progId ? resolveExecutable(firstToken(query(`HKCR\\${progId}\\shell\\open\\command`))) : null;
  } catch (_) {
    return null;
  }
}

// Returns the OS default browser executable, or null when it can't be found.
// macOS isn't supported, because its default lives in a binary LaunchServices
// plist.
function defaultBrowser() {
  if (process.platform === 'linux') return linuxDefaultBrowser();
  if (process.platform === 'win32') return windowsDefaultBrowser();
  return null;
}

// Returns the configured browser, then the OS default browser when it's
// Chromium-based, and then the first Chromium-based browser installed.
function findBrowser(configuredPath) {
  if (configuredPath) {
    return resolveExecutable(configuredPath);
  }
  const preferred = defaultBrowser();
  if (preferred && CHROMIUM_NAME.test(path.basename(preferred))) {
    return preferred;
  }
  for (const candidate of CANDIDATES[process.platform] || []) {
    if (Array.isArray(candidate)) {
      const root = process.env[candidate[0]];
      const full = root && path.join(root, candidate[1]);
      if (full && isExecutable(full)) return full;
    } else if (path.isAbsolute(candidate)) {
      if (isExecutable(candidate)) return candidate;
    } else {
      const found = findOnPath(candidate);
      if (found) return found;
    }
  }
  return null;
}

// Chrome writes "<port>\n<browser ws path>" to this file once DevTools is
// listening on the random port that `--remote-debugging-port=0` picks.
function readDevToolsEndpoint(profileDir) {
  try {
    const [port, wsPath] = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n');
    if (port && wsPath) {
      return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
    }
  } catch (_) {
    // Chrome hasn't written the file yet.
  }
  return null;
}

async function tryConnect(profileDir) {
  const endpoint = readDevToolsEndpoint(profileDir);
  if (!endpoint) {
    return null;
  }
  try {
    return await CdpClient.connect(endpoint, 2000);
  } catch (_) {
    return null;
  }
}

async function launch(browserPath, profileDir, timeoutMs) {
  fs.mkdirSync(profileDir, { recursive: true });
  // A leftover file from a crashed session would point at a dead port.
  fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true });

  const child = spawn(
    browserPath,
    [
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  let spawnError = null;
  child.on('error', err => {
    spawnError = err;
  });
  // Keeps the browser running after Insomnia exits.
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`Couldn't start ${browserPath}: ${spawnError.message}`);
    }
    const client = await tryConnect(profileDir);
    if (client) {
      return client;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`${browserPath} didn't open DevTools within ${timeoutMs} ms`);
}

// Serializes handoffs, so that two quick redirects don't race to launch two
// browsers on one profile.
let queue = Promise.resolve();

// Injects cookies into a dedicated Chromium profile, and then opens url in a new
// tab. Reuses the browser when it's already running on that profile.
function openWithCookies({ url, cdpCookies, browserPath, profileDir, timeoutMs }) {
  const run = async () => {
    let client = await tryConnect(profileDir);
    const freshLaunch = !client;
    if (!client) {
      client = await launch(browserPath, profileDir, timeoutMs);
    }

    try {
      const { targetInfos: before } = await client.send('Target.getTargets');

      if (cdpCookies.length) {
        await client.send('Storage.setCookies', { cookies: cdpCookies });
      }

      const { targetId } = await client.send('Target.createTarget', { url });
      await client.send('Target.activateTarget', { targetId }).catch(() => {});

      // Closes the about:blank tab that a fresh launch opens.
      if (freshLaunch) {
        for (const t of before) {
          if (t.type === 'page' && t.url === 'about:blank') {
            await client.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
          }
        }
      }
    } finally {
      client.close();
    }
  };

  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

function defaultProfileDir(dataDir) {
  return path.join(dataDir || os.tmpdir(), 'redirect-to-browser', 'profile');
}

module.exports = { findBrowser, openWithCookies, defaultProfileDir };
