# OpenChamber Desktop

Electron desktop runtime for OpenChamber on macOS and Windows.

This package owns the native shell: windows, menus, deep links, native notifications, auto-updates, host switching, SSH connections, tunnel helpers, and packaged desktop builds. The web UI and OpenChamber server logic still live in `packages/web` and shared React UI lives in `packages/ui`.

## How It Runs

Desktop starts the OpenChamber web server in the same Electron main process. There is no separate sidecar subprocess for the OpenChamber server.

`main.mjs` imports `@openchamber/web/server/index.js` and calls `startWebUiServer()`. The Electron window then loads the UI from the local server in development, or from packaged `resources/web-dist` assets in packaged builds.

The preload bridge exposes desktop-only APIs to the web UI through `window.__OPENCHAMBER_DESKTOP__`. Privileged commands are checked in `main.mjs`, not only in the UI.

## Main Files

| File | Purpose |
|------|---------|
| `main.mjs` | Electron main process, app lifecycle, windows, menus, deep links, native IPC handlers, updates, local server startup |
| `preload.mjs` | Safe bridge from the rendered UI to Electron IPC |
| `ssh-manager.mjs` | SSH host import, connection lifecycle, tunnel/port forwarding helpers |
| `scripts/electron-dev.mjs` | Desktop dev launcher with Vite HMR support |
| `scripts/build-web-assets.mjs` | Builds `packages/web` and stages UI assets into `resources/web-dist` |
| `scripts/bundle-main.mjs` | Bundles Electron main code into `dist-bundle/main.mjs` for packaging |
| `scripts/rebuild-native.mjs` | Rebuilds native modules against the Electron runtime |
| `scripts/package.mjs` | Runs `electron-builder`; on macOS auto-detects signing/notarization (and notarizes + staples the DMG), on Windows builds unsigned when signing env is missing |
| `scripts/install-dmg.mjs` | Installs the built host-arch DMG into `/Applications` (macOS only, used by `electron:install`) |
| `resources/` | Packaged web assets, icons, and macOS entitlements |

## Development

From the repo root:

```bash
bun install
bun run electron:dev
```

`bun run electron:dev` starts the web dev server with HMR, then launches Electron against `packages/electron/main.mjs`.

Useful variants:

```bash
bun run electron:dev:bundled
bun run type-check:electron
bun run lint:electron
```

`electron:dev:bundled` builds and uses packaged web assets instead of the HMR server. Use it when testing behavior closer to a packaged app.

## Packaging

From the repo root:

```bash
bun run electron:build
```

That runs, in order:

1. `build:web-assets` to build the web UI and copy it into `packages/electron/resources/web-dist`.
2. `bundle:main` to create `packages/electron/dist-bundle/main.mjs`.
3. `rebuild:native` to rebuild native modules for Electron.
4. `package.mjs` to run `electron-builder`.

Build output goes to `packages/electron/dist`.

macOS builds produce `dmg` and `zip` artifacts. Windows builds produce an NSIS installer.

### macOS signing and notarization

On macOS, `scripts/package.mjs` detects what your machine can do and picks the strongest option automatically. No flags are required.

| Detected on the machine | Result |
|---|---|
| `Developer ID Application` identity **and** a working notarytool keychain profile | Signed, then notarized and stapled DMG |
| `Developer ID Application` identity, but no usable notarytool profile | Signed DMG; notarization skipped with a warning |
| No `Developer ID Application` identity | Unsigned (ad-hoc) DMG with a warning; build still succeeds |

Details that matter in practice:

- Only a `Developer ID Application` identity counts. An `Apple Development` certificate is deliberately ignored, because it cannot produce distributable builds.
- Notarization requires signing. An unsigned build is never notarized.
- Notarization is done by `package.mjs` itself after the build (`xcrun notarytool submit --wait`, then `xcrun stapler staple`). electron-builder's own notarize step is always disabled for local builds, so a keychain profile is enough — no Apple credentials in the environment.
- All signing decisions are passed as electron-builder CLI overrides. The static `build` config in `package.json` is never modified, because macOS CI depends on it.

Env overrides:

| Variable | Values | Default | Effect |
|---|---|---|---|
| `OPENCHAMBER_MAC_SIGN` | `auto` \| `on` \| `off` | `auto` | `on` fails the build (exit 1) when no `Developer ID Application` identity is found instead of falling back to unsigned. `off` forces an unsigned build. |
| `OPENCHAMBER_NOTARIZE` | `auto` \| `on` \| `off` | `auto` | `on` fails the build (exit 1) when the notarytool profile is unusable instead of skipping. `off` skips notarization. |
| `OPENCHAMBER_NOTARY_PROFILE` | notarytool keychain profile name | `Default` | Which stored notarytool profile is used for the credential pre-flight and the submission. |

Any value other than `on` or `off` is treated as `auto`.

A notarytool keychain profile is created once with `xcrun notarytool store-credentials`; `package.mjs` then only references it by name, so no credentials are read from the environment or stored in this repo.

### Installing a local build (macOS)

From the repo root:

```bash
bun run electron:install
```

This runs `electron:build` and then `scripts/install-dmg.mjs`, which:

1. Picks the newest `OpenChamber-*-mac-<host-arch>.dmg` from `packages/electron/dist`. If no DMG matches the host architecture, it fails with a clear error instead of installing a mismatched build.
2. Quits a running OpenChamber instance, then replaces `/Applications/OpenChamber.app` using `ditto` so the code signature stays intact.
3. Staples the notarization ticket to the installed app when the DMG is notarized, so Gatekeeper also validates offline.
4. Verifies the result with `codesign --verify --deep --strict`.
5. Ejects the DMG volume afterwards, and warns if a volume cannot be ejected.

Note that this command quits a running OpenChamber — an app in `/Applications` cannot be replaced while it is running.

## Platform Notes

macOS packaging needs Xcode/build tools for notarized builds and icon asset compilation.

Windows packaging needs NSIS support through `electron-builder`. If no Windows signing env is set, `package.mjs` disables code signing and builds an unsigned installer.

The package supports macOS and Windows desktop features. Some native discovery helpers are platform-specific. For example, app icon fetching and app filtering currently only work on macOS, while opening files in installed apps works on macOS and Windows.

## Common Env Vars

| Variable | Use |
|----------|-----|
| `OPENCHAMBER_ELECTRON_DEV=1` | Marks the runtime as desktop development mode |
| `OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1` | Uses staged web assets instead of the HMR dev server |
| `OPENCHAMBER_HMR_UI_PORT` | Preferred Vite UI port for desktop dev, default `5173` |
| `OPENCHAMBER_HMR_API_PORT` | Preferred API port for desktop dev, default `3901` |
| `OPENCHAMBER_RUNTIME=desktop` | Set by Electron before starting the web server |
| `OPENCHAMBER_DESKTOP_NOTIFY=true` | Enables desktop notification flow in the web server |
| `OPENCHAMBER_SKIP_API_COMPRESSION=true` | Defaulted by Desktop to reduce local CPU overhead |
| `OPENCODE_HOST` / `OPENCODE_PORT` / `OPENCODE_SKIP_START` | Connect Desktop to an external OpenCode server instead of starting one locally |

## Native Features Owned Here

- Floating Mini Chat windows.
- Multiple native windows.
- Native notifications.
- One-click open/reveal/open-in-app actions.
- Desktop host switcher and deep-link imports.
- Local and remote instance handling.
- SSH host import, connections, logs, and port forwarding.
- Tunnel lifecycle integration through the web server runtime.
- Auto-update checks, downloads, and restart/apply flow.

## IPC Pattern

Renderer code should call the desktop bridge exposed by `preload.mjs`. Do not import Electron from shared UI code.

Add new native capabilities in this order:

1. Add or update the `preload.mjs` bridge only if a new renderer-facing shape is needed.
2. Add the real command handling in `main.mjs` under `openchamber:invoke`.
3. Gate privileged commands in main process logic so remote pages cannot access local filesystem or shell capabilities.
4. Keep shared UI runtime contracts in `packages/ui` and server/runtime APIs in `packages/web` when the behavior is not inherently native.

## Logs And Data

Electron uses `electron-log`. In development, console logs are also visible in the terminal. In packaged apps, logs are written through the platform log path for the `OpenChamber` app name.

Development builds use a separate user data directory named `OpenChamber Dev`, so dev state does not overwrite normal packaged app state.

## Things To Be Careful With

- Keep desktop-specific code in this package. Do not move OpenCode feature backend logic into Electron.
- Use hidden Windows process launches for background helpers. Avoid visible console flashes.
- Keep `@openchamber/web`, `bun-pty`, `node-pty`, and native modules external in `bundle-main.mjs`; bundling them can break Electron startup.
- Rebuild native modules after dependency or Electron version changes.
- Test both HMR dev mode and bundled UI mode when changing startup, preload, routing, or packaged asset behavior.

## Quick Checks

```bash
bun run type-check:electron
bun run lint:electron
bun run electron:dev:bundled
```

For full repo validation before shipping:

```bash
bun run type-check
bun run lint
```
