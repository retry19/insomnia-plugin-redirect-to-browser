'use strict';

const ENV_KEY = 'redirectToBrowser';

const DEFAULTS = Object.freeze({
  enabled: true,
  // "cookies" opens the URL in a dedicated profile with the cookies copied over.
  // "plain" opens the URL in the OS default browser and its everyday profile,
  // without cookies, because no browser lets another process write cookies
  // into that profile.
  mode: 'cookies',
  statusCodes: [301, 302, 303, 307, 308],
  // Absolute path to a Chromium-based browser. Empty means auto-detect.
  browserPath: '',
  // Dedicated browser profile. Empty means <Insomnia data dir>/redirect-to-browser/profile.
  profileDir: '',
  includeJarCookies: true,
  // Opens the URL in the OS default browser, without cookies, when no
  // Chromium-based browser is available.
  fallbackToDefaultBrowser: true,
  launchTimeoutMs: 15000,
});

// Merges the `redirectToBrowser` environment variable over DEFAULTS. Accepts an
// object, a JSON string, or a boolean shorthand for `enabled`.
function readConfig(context) {
  let raw = null;
  try {
    raw = context.request.getEnvironmentVariable(ENV_KEY);
  } catch (_) {
    // The variable is missing, so the defaults apply.
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === 'false' || trimmed === 'true') {
      raw = trimmed === 'true';
    } else {
      try {
        raw = JSON.parse(trimmed);
      } catch (_) {
        raw = null;
      }
    }
  }

  if (typeof raw === 'boolean') {
    return { ...DEFAULTS, enabled: raw };
  }
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULTS };
  }

  const cfg = { ...DEFAULTS, ...raw };
  cfg.statusCodes = Array.isArray(cfg.statusCodes) ? cfg.statusCodes.map(Number) : DEFAULTS.statusCodes;
  cfg.launchTimeoutMs = Number(cfg.launchTimeoutMs) || DEFAULTS.launchTimeoutMs;
  return cfg;
}

module.exports = { readConfig, DEFAULTS, ENV_KEY };
