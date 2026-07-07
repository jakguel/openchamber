import { CODE_FONT_OPTION_MAP, UI_FONT_OPTION_MAP, type FontFaceSource, type MonoFontOption, type UiFontOption } from '@/lib/fontOptions';

const loadedFaces = new Set<string>();
const pendingFaces = new Map<string, Promise<void>>();

/* The catalog woff2 are vendored under src/assets/fonts and were previously
   fetched at runtime from a public CDN, which broke offline use. `eager`
   here materializes only the hashed, base-aware asset URL STRINGS at module
   load (Vite emits them for both the web and vscode builds); it does NOT fetch
   the font bytes. The per-family byte download stays deferred to the
   FontFace.load() call in loadFace, so selection remains lazy and on-demand.
   A static `?url` glob is the only Vite-analyzable form — a template-literal
   `new URL(`...${var}`)` specifier would not be emitted and would ship a broken
   offline URL. */
const vendoredFontUrls = import.meta.glob<string>('../assets/fonts/**/*.woff2', {
  eager: true,
  query: '?url',
  import: 'default',
});

const fontUrlByFileName = new Map<string, string>();
for (const [modulePath, url] of Object.entries(vendoredFontUrls)) {
  const fileName = modulePath.split('/').pop();
  if (fileName) {
    fontUrlByFileName.set(fileName, url);
  }
}

const buildFontUrl = (source: FontFaceSource, weight: number): string | undefined =>
  fontUrlByFileName.get(`${source.filePrefix}-latin-${weight}-normal.woff2`);

const loadFace = (source: FontFaceSource, weight: number) => {
  const key = `${source.family}:${weight}`;
  if (loadedFaces.has(key)) {
    return Promise.resolve();
  }

  const pending = pendingFaces.get(key);
  if (pending) {
    return pending;
  }

  if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) {
    return Promise.resolve();
  }

  const url = buildFontUrl(source, weight);
  if (!url) {
    console.warn(`No vendored font asset for: ${source.family} ${weight}`);
    return Promise.resolve();
  }

  const face = new FontFace(source.family, `url(${url}) format('woff2')`, {
    style: 'normal',
    weight: String(weight),
    display: 'swap',
  });

  document.fonts.add(face);
  const promise = face.load()
    .then(() => {
      loadedFaces.add(key);
    })
    .catch((error) => {
      document.fonts.delete(face);
      console.warn(`Failed to load font: ${source.family} ${weight}`, error);
    })
    .finally(() => {
      pendingFaces.delete(key);
    });

  pendingFaces.set(key, promise);
  return promise;
};

const loadSource = (source: FontFaceSource | undefined) => {
  if (!source) {
    return Promise.resolve();
  }

  return Promise.all(source.weights.map((weight) => loadFace(source, weight))).then(() => undefined);
};

export const loadUiFont = (font: UiFontOption) => loadSource(UI_FONT_OPTION_MAP[font]?.source);

export const loadMonoFont = (font: MonoFontOption) => loadSource(CODE_FONT_OPTION_MAP[font]?.source);
