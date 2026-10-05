# Redirect to browser

An Insomnia plugin that opens a redirect response in your browser and carries
over the session. When a request returns a `3xx` response with a `Location`
header, the plugin opens that URL in your default browser if it's
Chromium-based, or else in another installed Chromium-based browser. Before it
opens the URL, the plugin copies these cookies into the browser:

- The cookies in the workspace cookie jar.
- The cookies from the response's `Set-Cookie` headers.

Use it to test login, OAuth, SSO, and payment flows that start as an API call
and continue in a web page.

## Prerequisites

- Insomnia 9 or later. This plugin is tested on Insomnia 11.2.
- A Chromium-based browser: Google Chrome, Chromium, Microsoft Edge, or Brave.

## Install the plugin

1. Copy this directory to the Insomnia plugins directory:
   - Linux: `~/.config/Insomnia/plugins/`
   - macOS: `~/Library/Application Support/Insomnia/plugins/`
   - Windows: `%APPDATA%\Insomnia\plugins\`
2. In Insomnia, go to **Preferences > Plugins**, and then click
   **Reload plugins**.

## Use the plugin

1. Open the request settings, and then turn off **Follow redirects**. If
   Insomnia follows the redirect itself, the plugin never sees the `3xx`
   response.
2. Send the request.

When the response is a redirect, a new tab opens with the cookies already in
place. The response still appears in Insomnia as usual.

The plugin uses a dedicated browser profile, so the tab opens in a separate
browser window without your bookmarks or sign-ins. After the first launch, the
plugin reuses that window and opens each redirect in a new tab.

## Choose between cookies and your everyday profile

No browser lets another process write cookies into your everyday profile.
Since Chrome 136, Chrome also blocks remote debugging on its default profile.
So you need to choose one of the following modes:

- `"mode": "cookies"` (default): Opens the URL in your default browser, using
  a dedicated profile that has the Insomnia cookies.
- `"mode": "plain"`: Opens the URL in your default browser and your everyday
  profile, without the Insomnia cookies. Use this mode when the redirect URL
  carries its own credentials, such as a one-time token or an OAuth code.

## Configuration

To configure the plugin, add a `redirectToBrowser` variable to an Insomnia
environment. Any key that you leave out keeps its default value.

```json
{
  "redirectToBrowser": {
    "enabled": true,
    "mode": "cookies",
    "statusCodes": [301, 302, 303, 307, 308],
    "browserPath": "",
    "profileDir": "",
    "includeJarCookies": true,
    "fallbackToDefaultBrowser": true,
    "launchTimeoutMs": 15000
  }
}
```

To turn off the plugin for one environment, set `"redirectToBrowser": false`.

| Key | Description | Default |
|---|---|---|
| `enabled` | Whether the plugin handles redirects. | `true` |
| `mode` | `cookies` to copy cookies into a dedicated profile, or `plain` to open the URL in your everyday profile without cookies. | `cookies` |
| `statusCodes` | The status codes that trigger the plugin. | `[301, 302, 303, 307, 308]` |
| `browserPath` | The browser executable, as an absolute path or a command name. An empty value uses the OS default browser if it's Chromium-based, and otherwise auto-detects Chrome, Chromium, Edge, or Brave. Default browser detection works on Linux and Windows. | `""` |
| `profileDir` | The browser profile directory. | `<Insomnia data>/redirect-to-browser/profile` |
| `includeJarCookies` | Whether to copy the workspace cookie jar. If `false`, the plugin copies only the response's `Set-Cookie` cookies. | `true` |
| `fallbackToDefaultBrowser` | Whether to open the URL in the default browser, without cookies, when no Chromium-based browser is available. | `true` |
| `launchTimeoutMs` | How long to wait for the browser to start, in milliseconds. | `15000` |

## How it works

1. A response hook checks the status code and the `Location` header, and then
   resolves a relative `Location` against the request URL.
2. The plugin reads the workspace cookie jar from `insomnia.CookieJar.db`,
   because the Insomnia plugin API doesn't expose the jar. It then merges the
   jar with the response's `Set-Cookie` cookies and drops expired cookies.
3. The plugin finds the browser. On Linux it reads `xdg-settings`, and on
   Windows it reads the `https` URL association in the registry.
4. The plugin starts the browser with `--remote-debugging-port=0` on a
   dedicated profile, or connects to the browser that already runs on that
   profile.
5. The plugin calls the Chrome DevTools Protocol method `Storage.setCookies`,
   and then `Target.createTarget` to open the URL.

The hook doesn't wait for the browser, so a slow launch doesn't delay the
response in Insomnia.

## Security considerations

- The DevTools port listens only on `127.0.0.1`, and the browser picks a
  random port.
- The plugin doesn't pass `--remote-allow-origins`. Chrome rejects any DevTools
  connection that carries an `Origin` header, so a web page can't control the
  browser. Other local processes running as your user can still connect to
  the port.
- The dedicated profile stores the copied cookies, which can include session
  tokens. To clear them, close the browser and delete `profileDir`.

## Limitations

- The plugin copies cookies only. The browser can't send request headers such
  as `Authorization`, because a normal page navigation doesn't carry custom
  headers.
- Firefox isn't supported for cookie handoff. If you set `browserPath` to
  Firefox, the browser opens the URL but the plugin can't copy the cookies.
- The plugin doesn't handle a `200` response that redirects with an HTML form
  or a `<meta http-equiv="refresh">` tag, such as a SAML POST binding.
- Request runners and other plugins that send requests also trigger the
  plugin. To prevent this, set `"redirectToBrowser": false` in the
  environment that you use for those runs.

## Troubleshooting

### Nothing opens after a redirect

Insomnia probably followed the redirect. To fix it, turn off **Follow
redirects** for the request, or in **Preferences > General**.

### The browser opens, but you're not signed in

The cookie might be missing from the workspace cookie jar. To check, open
**Cookies** in Insomnia, and confirm that the cookie exists for the target
domain. Also check that **Store cookies automatically** is on for the requests
that sign you in.

### "Redirect to browser failed" appears

The plugin couldn't start or reach the browser. To find the cause, open
**View > Toggle DevTools** in Insomnia, and then search the console for
`[redirect-to-browser]`. If the browser is a Snap package, set `profileDir`
to a directory that the Snap can access, or set `browserPath` to a
non-Snap browser.
