'use strict';

const fs = require('fs');
const path = require('path');

// Reads the workspace cookie jar straight from Insomnia's NeDB file, because
// the plugin API doesn't expose the jar. NeDB is append-only: the last line for
// an _id wins, and `$$deleted` marks a removed document.
function readJarCookies(dataDir, workspaceId) {
  if (!dataDir || !workspaceId) {
    return [];
  }

  let content;
  try {
    content = fs.readFileSync(path.join(dataDir, 'insomnia.CookieJar.db'), 'utf8');
  } catch (_) {
    return [];
  }

  const docs = new Map();
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!doc || !doc._id) {
      continue;
    }
    if (doc.$$deleted) {
      docs.delete(doc._id);
    } else {
      docs.set(doc._id, doc);
    }
  }

  const jar = [...docs.values()]
    .filter(d => d.parentId === workspaceId)
    .sort((a, b) => (b.modified || 0) - (a.modified || 0))[0];

  return jar && Array.isArray(jar.cookies) ? jar.cookies.map(fromToughCookie).filter(Boolean) : [];
}

// Converts a tough-cookie JSON object, as stored by Insomnia, to the shared
// internal shape.
function fromToughCookie(c) {
  if (!c || !c.key || !c.domain) {
    return null;
  }
  let expires;
  if (c.expires && c.expires !== 'Infinity') {
    const t = Date.parse(c.expires);
    if (!Number.isNaN(t)) {
      expires = t / 1000;
    }
  }
  return {
    name: c.key,
    value: c.value == null ? '' : String(c.value),
    domain: String(c.domain).replace(/^\./, ''),
    hostOnly: Boolean(c.hostOnly),
    path: c.path || '/',
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    sameSite: c.sameSite,
    expires,
  };
}

// Parses Set-Cookie header values relative to the URL that returned them,
// following RFC 6265 section 5.2.
function parseSetCookies(values, requestUrl) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  let base;
  try {
    base = new URL(requestUrl);
  } catch (_) {
    return [];
  }
  return list.map(v => parseSetCookie(v, base)).filter(Boolean);
}

function parseSetCookie(header, base) {
  const [pair, ...attrs] = String(header).split(';');
  const eq = pair.indexOf('=');
  if (eq < 1) {
    return null;
  }

  const cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: base.hostname,
    hostOnly: true,
    path: defaultPath(base.pathname),
    secure: false,
    httpOnly: false,
    sameSite: undefined,
    expires: undefined,
  };

  let maxAge;
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : attr.slice(i + 1).trim();
    switch (key) {
      case 'domain':
        if (val) {
          cookie.domain = val.replace(/^\./, '').toLowerCase();
          cookie.hostOnly = false;
        }
        break;
      case 'path':
        if (val.startsWith('/')) {
          cookie.path = val;
        }
        break;
      case 'expires': {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) {
          cookie.expires = t / 1000;
        }
        break;
      }
      case 'max-age':
        if (/^-?\d+$/.test(val)) {
          maxAge = Number(val);
        }
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite':
        cookie.sameSite = val.toLowerCase();
        break;
      default:
        break;
    }
  }

  // Max-Age takes precedence over Expires.
  if (maxAge !== undefined) {
    cookie.expires = Date.now() / 1000 + maxAge;
  }
  return cookie;
}

function defaultPath(pathname) {
  if (!pathname || !pathname.startsWith('/')) {
    return '/';
  }
  const last = pathname.lastIndexOf('/');
  return last <= 0 ? '/' : pathname.slice(0, last);
}

// Combines cookie lists and drops expired cookies. A later list overrides an
// earlier one for the same name, domain, and path.
function mergeCookies(...lists) {
  const now = Date.now() / 1000;
  const byKey = new Map();
  for (const list of lists) {
    for (const c of list) {
      byKey.set(`${c.name}\u0000${c.domain}\u0000${c.path}`, c);
    }
  }
  return [...byKey.values()].filter(c => c.expires === undefined || c.expires > now);
}

// Maps internal cookies to Chrome DevTools Protocol `Network.CookieParam`.
function toCdpCookies(cookies) {
  return cookies.map(c => {
    const param = {
      name: c.name,
      value: c.value,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
    };
    if (c.hostOnly) {
      // Passing `url` without `domain` creates a host-only cookie.
      param.url = `${c.secure ? 'https' : 'http'}://${c.domain}${c.path}`;
    } else {
      param.domain = `.${c.domain}`;
    }
    const sameSite = { strict: 'Strict', lax: 'Lax', none: 'None' }[String(c.sameSite || '').toLowerCase()];
    // Chrome rejects SameSite=None on a cookie that isn't Secure.
    if (sameSite && !(sameSite === 'None' && !c.secure)) {
      param.sameSite = sameSite;
    }
    if (c.expires !== undefined) {
      param.expires = c.expires;
    }
    return param;
  });
}

module.exports = { readJarCookies, parseSetCookies, mergeCookies, toCdpCookies };
