import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Installs the DMG produced by the intelligent build (see package.mjs) into /Applications.
 *
 * macOS only. Uses Node built-ins + system CLIs (hdiutil, ditto, xcrun, codesign, osascript,
 * pkill) — no new dependencies. Wired via the root `electron:install` script:
 *   bun run electron:build && node ./packages/electron/scripts/install-dmg.mjs
 */

if (process.platform !== 'darwin') {
  console.error('[install] electron:install is macOS-only.');
  process.exit(1);
}

const APP_NAME = 'OpenChamber.app';
const APPLICATIONS = '/Applications';
const distDir = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));

function fail(message) {
  console.error(`[install] ${message}`);
  process.exit(1);
}

function findHostArchDmg() {
  if (!fs.existsSync(distDir)) return null;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  const allDmgs = fs.readdirSync(distDir).filter((f) => f.endsWith('.dmg'));
  const candidates = allDmgs.filter((f) => f.includes(`-mac-${arch}.dmg`));
  const pick = candidates.length > 0 ? candidates : allDmgs;
  if (pick.length === 0) return null;
  pick.sort(
    (a, b) =>
      fs.statSync(path.join(distDir, b)).mtimeMs - fs.statSync(path.join(distDir, a)).mtimeMs,
  );
  return path.join(distDir, pick[0]);
}

function quitRunningApp() {
  // Best-effort: quit a running instance so we can replace it cleanly (idempotent installs).
  spawnSync('osascript', ['-e', 'tell application "OpenChamber" to quit'], { stdio: 'ignore' });
  spawnSync('pkill', ['-f', '/Applications/OpenChamber.app/Contents/MacOS/OpenChamber'], {
    stdio: 'ignore',
  });
}

function dmgIsNotarized(dmg) {
  // A stapled notarization ticket on the DMG means the app's cdhash was notarized too.
  const r = spawnSync('xcrun', ['stapler', 'validate', dmg], { stdio: 'ignore' });
  return r.status === 0;
}

function attach(dmg) {
  const out = execFileSync('hdiutil', ['attach', dmg, '-nobrowse', '-noverify', '-plist'], {
    encoding: 'utf8',
  });
  const mounts = [...out.matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/g)].map(
    (m) => m[1],
  );
  const mount = mounts.find((m) => m.startsWith('/Volumes/'));
  if (!mount) throw new Error('could not determine DMG mount point');
  return mount;
}

function detach(mount) {
  const r = spawnSync('hdiutil', ['detach', mount], { stdio: 'ignore' });
  if (r.status !== 0) {
    // Retry with -force to avoid leaving an orphaned mounted volume.
    spawnSync('hdiutil', ['detach', mount, '-force'], { stdio: 'ignore' });
  }
}

function ejectImageMounts(dmgPath) {
  // `electron:install` runs build + install: the electron-builder build step that
  // produces the DMG can leave it mounted, and that mount is not the one our own
  // attach() captured. Sweep every attached device backed by THIS dmg image so the
  // combined command never leaves an orphaned /Volumes entry (regardless of source).
  let target;
  try {
    target = fs.realpathSync(dmgPath);
  } catch (error) {
    console.warn(`[install] cannot resolve DMG path for mount cleanup: ${error.message || error}`);
    return;
  }

  let info;
  try {
    info = execFileSync('hdiutil', ['info'], { encoding: 'utf8' });
  } catch (error) {
    console.warn(`[install] hdiutil info failed during mount cleanup: ${error.message || error}`);
    return;
  }

  // hdiutil info separates image entries with a run of '=' characters.
  const blocks = info.split(/^={10,}$/m);
  for (const block of blocks) {
    const pathMatch = block.match(/^image-path\s*:\s*(.+)$/m);
    if (!pathMatch) continue;

    let imgPath;
    try {
      imgPath = fs.realpathSync(pathMatch[1].trim());
    } catch {
      // Backing image no longer resolvable — cannot be our freshly built target; skip.
      continue;
    }
    if (imgPath !== target) continue;

    // Detach the whole-disk device (e.g. /dev/disk6), which ejects all its slices.
    const devMatch = block.match(/^(\/dev\/disk\d+)\b/m);
    if (!devMatch) continue;
    const dev = devMatch[1];
    const r = spawnSync('hdiutil', ['detach', dev], { stdio: 'ignore' });
    if (r.status !== 0) {
      spawnSync('hdiutil', ['detach', dev, '-force'], { stdio: 'ignore' });
    }
  }
}

const dmg = findHostArchDmg();
if (!dmg) fail(`no host-arch DMG found in ${distDir} — run the build first.`);
console.log(`[install] installing ${path.basename(dmg)} ...`);

const notarized = dmgIsNotarized(dmg);

let mount = null;
let exitCode = 0;
try {
  mount = attach(dmg);
  const srcApp = path.join(mount, APP_NAME);
  if (!fs.existsSync(srcApp)) {
    throw new Error(`${APP_NAME} not found in mounted DMG at ${mount}`);
  }

  quitRunningApp();
  const destApp = path.join(APPLICATIONS, APP_NAME);
  fs.rmSync(destApp, { recursive: true, force: true });

  // ditto preserves the code signature and extended attributes (cp -R can damage them).
  execFileSync('ditto', [srcApp, destApp], { stdio: 'inherit' });
  console.log(`[install] copied to ${destApp}`);

  if (notarized) {
    try {
      execFileSync('xcrun', ['stapler', 'staple', destApp], { stdio: 'inherit' });
      console.log('[install] stapled notarization ticket to installed app.');
    } catch (error) {
      console.warn(
        `[install] WARNING: could not staple installed app (${error.message || error}); the app is notarized and will validate online.`,
      );
    }
  } else {
    console.warn(
      '[install] WARNING: DMG is not notarized; installed app is signed/ad-hoc only (no offline notarization ticket).',
    );
  }
} catch (error) {
  console.error(`[install] failed: ${error.message || error}`);
  exitCode = 1;
} finally {
  if (mount) detach(mount);
  // Deterministic sweep: eject any remaining volumes backed by this DMG (e.g. a
  // mount left behind by the electron-builder build step) so no orphan survives.
  ejectImageMounts(dmg);
}

if (exitCode === 0) {
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', path.join(APPLICATIONS, APP_NAME)], {
      stdio: 'inherit',
    });
    console.log('[install] codesign verify OK.');
  } catch (error) {
    console.error(`[install] installed app failed codesign verify: ${error.message || error}`);
    exitCode = 1;
  }
}

if (exitCode === 0) console.log('[install] done.');
process.exit(exitCode);
