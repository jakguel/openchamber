import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * electron-builder wrapper with intelligent, auto-detecting macOS signing + notarization.
 *
 * Behavior (macOS local builds only — macOS CI invokes electron-builder directly and is
 * unaffected by this file; Windows CI runs `node ./scripts/package.mjs --win` and only
 * hits the win32 branch below):
 *   - If a valid "Developer ID Application" identity exists -> sign (pin that identity).
 *   - If ALSO a working notarytool keychain profile exists -> after a successful build,
 *     notarize the produced DMG and staple it.
 *   - If no identity -> fall back to an UNSIGNED (ad-hoc) build without failing.
 *
 * All signing/notarize decisions are applied as electron-builder CLI overrides ONLY;
 * the static `build` config in package.json is never edited (macOS CI depends on it).
 *
 * Env overrides:
 *   OPENCHAMBER_MAC_SIGN       = auto | on | off   (default auto)
 *   OPENCHAMBER_NOTARIZE       = auto | on | off   (default auto)
 *   OPENCHAMBER_NOTARY_PROFILE = <notarytool keychain profile name>  (default "Default")
 */

const env = { ...process.env };
const isDarwin = process.platform === 'darwin';
const isWin = process.platform === 'win32';

if (isWin && !env.CSC_LINK && !env.WINDOWS_CSC_LINK) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  console.log('[electron] Windows code signing disabled; building unsigned installer.');
}

const extraArgs = [];
// macPlan is only set on darwin; it drives the post-build notarize+staple step.
let macPlan = null;

function readEnvMode(name) {
  const v = String(env[name] || 'auto').toLowerCase();
  return v === 'on' || v === 'off' ? v : 'auto';
}

function detectDeveloperIdIdentity() {
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    // Only match the distribution cert; "Apple Development" must NOT count as signable.
    const m = out.match(/"(Developer ID Application:[^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function notaryProfileWorks(profile) {
  try {
    // Fast credential pre-flight (seconds) — avoids the slow-upload trap.
    execFileSync('xcrun', ['notarytool', 'history', '--keychain-profile', profile], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

if (isDarwin) {
  const signMode = readEnvMode('OPENCHAMBER_MAC_SIGN');
  const notarizeMode = readEnvMode('OPENCHAMBER_NOTARIZE');
  const profile = env.OPENCHAMBER_NOTARY_PROFILE || 'Default';

  let identityCN = null;
  let sign = false;
  if (signMode !== 'off') {
    identityCN = detectDeveloperIdIdentity();
    if (signMode === 'on') {
      if (!identityCN) {
        console.error(
          '[electron] OPENCHAMBER_MAC_SIGN=on but no "Developer ID Application" identity found in keychain.',
        );
        process.exit(1);
      }
      sign = true;
    } else {
      sign = Boolean(identityCN);
    }
  }

  let notarize = false;
  if (sign && notarizeMode !== 'off') {
    const profileOk = notaryProfileWorks(profile);
    if (notarizeMode === 'on') {
      if (!profileOk) {
        console.error(
          `[electron] OPENCHAMBER_NOTARIZE=on but notarytool keychain profile "${profile}" is not usable.`,
        );
        process.exit(1);
      }
      notarize = true;
    } else {
      notarize = profileOk;
    }
  }

  // We own notarization ourselves (post-build), so electron-builder's own notarize is
  // always disabled for local builds.
  extraArgs.push('-c.mac.notarize=false');

  if (sign) {
    // electron-builder wants the identity name WITHOUT the "Developer ID Application: " prefix.
    const identityName = identityCN.replace(/^Developer ID Application:\s*/, '');
    extraArgs.push(`-c.mac.identity=${identityName}`);
    console.log(`[electron] macOS signing ENABLED with "${identityCN}".`);
    if (!notarize) {
      console.warn(
        `[electron] WARNING: notarization SKIPPED (notarytool profile "${profile}" not usable); DMG will be signed but NOT notarized.`,
      );
    }
  } else {
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    extraArgs.push('-c.dmg.sign=false');
    console.warn(
      '[electron] WARNING: no "Developer ID Application" identity -> building UNSIGNED (ad-hoc) DMG; notarization skipped.',
    );
  }

  macPlan = { sign, notarize, profile };
}

function findHostArchDmg() {
  const distDir = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));
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

async function runMacNotarize(plan) {
  const dmg = findHostArchDmg();
  if (!dmg) {
    throw new Error('no host-arch DMG found in dist to notarize');
  }
  console.log(`[electron] notarizing ${path.basename(dmg)} ...`);
  const out = execFileSync(
    'xcrun',
    [
      'notarytool',
      'submit',
      dmg,
      '--keychain-profile',
      plan.profile,
      '--wait',
      '--output-format',
      'json',
    ],
    { encoding: 'utf8' },
  );
  let status;
  try {
    status = JSON.parse(out).status;
  } catch {
    throw new Error(`could not parse notarytool JSON output: ${out.slice(0, 200)}`);
  }
  if (status !== 'Accepted') {
    throw new Error(`notarization status=${status} (not Accepted); DMG not stapled`);
  }
  console.log('[electron] notarization Accepted; stapling DMG ...');
  execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
  console.log('[electron] DMG notarized + stapled.');
}

const bunBinaryCandidates = [
  process.env.npm_execpath,
  process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', isWin ? 'bun.exe' : 'bun') : null,
  isWin ? 'bun.exe' : 'bun',
].filter(Boolean);

const bunBinary = bunBinaryCandidates.find((candidate) => {
  if (path.basename(candidate).toLowerCase().startsWith('bun')) {
    return candidate === 'bun' || candidate === 'bun.exe' || fs.existsSync(candidate);
  }
  return false;
}) || (isWin ? 'bun.exe' : 'bun');

const child = spawn(bunBinary, ['x', 'electron-builder', ...process.argv.slice(2), ...extraArgs], {
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  const exitCode = code ?? 1;
  if (isDarwin && macPlan && macPlan.sign && macPlan.notarize && exitCode === 0) {
    runMacNotarize(macPlan)
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('[electron] notarization/stapling failed:', error.message || error);
        process.exit(1);
      });
    return;
  }
  process.exit(exitCode);
});

child.on('error', (error) => {
  console.error('[electron] failed to start electron-builder:', error);
  process.exit(1);
});
