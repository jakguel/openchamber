

/* Load KaTeX styles eagerly with the main bundle (styles/fonts is imported by
   every entrypoint). Importing them inside the lazy MarkdownRendererImpl chunk
   meant a stylesheet was injected late on the first markdown render of a
   session; that late injection triggered a style recalc during which the
   layered `.chat-message-column` width clamp briefly lost, flashing message
   text to full width before it snapped back. Keeping this import in index.css
   made Tailwind v4 inline it and re-base KaTeX's relative url(fonts/KaTeX_*)
   against packages/ui/src/ (no fonts dir), so the math fonts never bundled.
   A JS-side import lets Vite rewrite the url() and emit the hashed woff2.
   katex-overrides.css is imported immediately AFTER so its theme color rules
   win the cascade regardless of entrypoint import order. */
import 'katex/dist/katex.min.css';
import './katex-overrides.css';

import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';

import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';

/* Nerd Fonts supply the terminal Private-Use-Area icon glyphs (powerline
   symbols, file-type icons, etc.). These were previously pulled from
   cdn.jsdelivr.net in packages/web/index.html, which broke offline use and
   only reached the web surface. Vendoring the woff2 under src/assets/fonts and
   registering them here via the CSS Font Loading API means EVERY entrypoint
   that imports './styles/fonts' — web, electron, vscode, mobile, mini-chat —
   gets the glyphs same-origin and offline.

   Static `?url` imports are the ONLY Vite-safe way to reference the bytes: Vite
   emits them as hashed, base-aware asset URLs in both the web build and the
   separate vscode webview build. A template-literal `new URL(`...${var}`)`
   specifier is NOT statically analyzable, so Vite would leave it unrewritten
   and ship a broken offline URL — never do that.

   The literal family names 'JetBrainsMono Nerd Font' and 'FiraCode Nerd Font'
   and the PUA unicode-range are a contract: index.css (.fonts-loaded
   .terminal-viewport-container) and lib/terminalTheme.ts select the font by
   these exact strings. Renaming either breaks terminal icon rendering.

   `.fonts-loaded` on <html> gates the terminal font entirely (index.css). It
   must be (re-)emitted only AFTER the faces settle so the terminal does not
   fall back before the icon font is ready. */
import jetBrainsMonoNerdFontUrl from '../assets/fonts/JetBrainsMonoNerdFont-Regular.woff2?url';
import firaCodeNerdFontUrl from '../assets/fonts/FiraCodeNerdFont-Regular.woff2?url';

const NERD_FONT_UNICODE_RANGE = 'U+E000-F8FF, U+F0000-FFFFF';

const nerdFontSpecs: ReadonlyArray<{ family: string; url: string }> = [
  { family: 'JetBrainsMono Nerd Font', url: jetBrainsMonoNerdFontUrl },
  { family: 'FiraCode Nerd Font', url: firaCodeNerdFontUrl },
];

function registerNerdFonts(): void {
  if (typeof document === 'undefined' || !('fonts' in document)) {
    return;
  }

  const markFontsLoaded = (): void => {
    document.documentElement.classList.add('fonts-loaded');
  };

  const faces = nerdFontSpecs.map(({ family, url }) => {
    // `local()` first so an OS-installed Nerd Font is used before the vendored
    // file; the vendored woff2 is the offline-safe fallback.
    const face = new FontFace(family, `local('${family}'), url(${url}) format('woff2')`, {
      unicodeRange: NERD_FONT_UNICODE_RANGE,
      display: 'swap',
    });
    document.fonts.add(face);
    return face;
  });

  // If every family already resolves (OS-installed or a cached face), the gate
  // can be set synchronously without waiting on a network/disk round-trip.
  // The sample text MUST be a Private-Use-Area glyph inside the declared
  // unicode-range (U+E000-F8FF): document.fonts.check() with no/whitespace
  // sample tests U+0020, which is outside the range, so it would report the
  // icon faces as "available" before they have actually loaded.
  const puaSampleGlyph = '\uE000';
  const alreadyAvailable = nerdFontSpecs.every(({ family }) =>
    document.fonts.check(`16px '${family}'`, puaSampleGlyph),
  );
  if (alreadyAvailable) {
    markFontsLoaded();
    return;
  }

  // Otherwise settle the faces first, then re-emit the gate. Font load failures
  // must not withhold `.fonts-loaded` — allSettled resolves regardless so the
  // terminal still gets its font stack (icon glyphs degrade to fallback only).
  Promise.allSettled(faces.map((face) => face.load()))
    .then(markFontsLoaded)
    .catch(markFontsLoaded);
}

registerNerdFonts();
