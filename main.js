'use strict';

const { readConfig } = require('./lib/config');
const { readJarCookies, parseSetCookies, mergeCookies, toCdpCookies } = require('./lib/cookies');
const { findBrowser, openWithCookies, defaultProfileDir } = require('./lib/browser');

const LOG = '[redirect-to-browser]';

function getDataDir() {
  if (process.env.INSOMNIA_DATA_PATH) {
    return process.env.INSOMNIA_DATA_PATH;
  }
  try {
    return window.app.getPath('userData');
  } catch (_) {
    return null;
  }
}

function getWorkspaceId(context) {
  try {
    return context.request.getEnvironment().getMeta().workspaceId || null;
  } catch (_) {
    return null;
  }
}

// Returns the absolute redirect target, or null when the response isn't a
// redirect this plugin handles.
function getRedirectUrl(context, cfg) {
  if (!cfg.statusCodes.includes(context.response.getStatusCode())) {
    return null;
  }
  let location = context.response.getHeader('location');
  if (Array.isArray(location)) {
    location = location[0];
  }
  if (!location) {
    return null;
  }
  try {
    const target = new URL(String(location).trim(), context.request.getUrl());
    return target.protocol === 'http:' || target.protocol === 'https:' ? target.toString() : null;
  } catch (_) {
    return null;
  }
}

function openInDefaultBrowser(url) {
  // Main-process IPC that calls shell.openExternal for http and https URLs.
  window.main.openInBrowser(url);
}

async function handoff(context, cfg, url) {
  if (cfg.mode === 'plain') {
    openInDefaultBrowser(url);
    return;
  }

  const dataDir = getDataDir();
  const requestUrl = context.request.getUrl();

  const jarCookies = cfg.includeJarCookies ? readJarCookies(dataDir, getWorkspaceId(context)) : [];
  // Response cookies win, because the jar might not hold them when
  // "Store cookies automatically" is off.
  const responseCookies = parseSetCookies(context.response.getHeader('set-cookie'), requestUrl);
  const cookies = mergeCookies(jarCookies, responseCookies);

  const browserPath = findBrowser(cfg.browserPath);
  if (!browserPath) {
    if (!cfg.fallbackToDefaultBrowser) {
      throw new Error('No Chromium-based browser found. Set redirectToBrowser.browserPath.');
    }
    console.warn(`${LOG} No Chromium-based browser found. Opening without cookies: ${url}`);
    openInDefaultBrowser(url);
    return;
  }

  await openWithCookies({
    url,
    cdpCookies: toCdpCookies(cookies),
    browserPath,
    profileDir: cfg.profileDir || defaultProfileDir(dataDir),
    timeoutMs: cfg.launchTimeoutMs,
  });
  console.log(`${LOG} Opened ${url} in ${browserPath} with ${cookies.length} cookie(s)`);
}

async function onResponse(context) {
  const cfg = readConfig(context);
  if (!cfg.enabled) {
    return;
  }
  const url = getRedirectUrl(context, cfg);
  if (!url) {
    return;
  }

  // Runs on a later tick, so that browser detection and launch don't delay
  // the response in Insomnia. A thrown error would also replace the response
  // with a plugin error, so every failure is caught here.
  setTimeout(() => handoff(context, cfg, url).catch(err => {
    console.error(`${LOG} Failed to open ${url}`, err);
    try {
      context.app.alert('Redirect to browser failed', `${err.message}\n\nURL: ${url}`);
    } catch (_) {
      // The alert is optional.
    }
  }), 0);
}

module.exports.responseHooks = [onResponse];
