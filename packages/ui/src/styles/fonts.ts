

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
