import DOMPurify from 'dompurify';

// Elements that AUTOMATICALLY fetch the resource named by their href/xlink:href — the SSRF /
// data-exfil surface. Click-initiated <a> is intentionally excluded (DOMPurify already blocks
// javascript:); its remote hyperlinks are a diagram feature, not an auto-fetch.
const AUTO_FETCH_TAGS = new Set(['image', 'use', 'feimage']);

// A reference is network-free (safe to keep) ONLY if it is an inline data: URI (C4 sprite
// imagery) or a same-document #fragment (SVG <use>/gradient/filter refs). Everything else —
// http(s):, //host, /path, path, blob:, etc. — is a remote fetch and is blocked.
function isLocalRef(value: string): boolean {
    const v = value.trim();
    return v.startsWith('#') || /^data:/i.test(v);
}

// CSS url(...) references (in style attributes, presentation attributes like fill/stroke/filter,
// and <style> blocks) can pull remote paint servers/images. Neutralize any non-local url() to
// url(#none) placeholder while preserving fragment (url(#grad)) and data: sprite references.
function scrubRemoteUrls(css: string): string {
    return css.replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (full: string, _quote: string, ref: string) =>
        isLocalRef(ref) ? full : 'none',
    );
}

function hardenSvgNode(node: Element): void {
    const tag = node.localName.toLowerCase();
    const isAutoFetch = AUTO_FETCH_TAGS.has(tag);
    for (const attr of Array.from(node.attributes)) {
        const name = attr.localName.toLowerCase();
        if (isAutoFetch && name === 'href' && !isLocalRef(attr.value)) {
            node.removeAttributeNode(attr);
            continue;
        }
        if (attr.value.toLowerCase().includes('url(')) {
            const cleaned = scrubRemoteUrls(attr.value);
            if (cleaned !== attr.value) attr.value = cleaned;
        }
    }
    if (tag === 'style' && node.textContent && node.textContent.toLowerCase().includes('url(')) {
        const cleaned = scrubRemoteUrls(node.textContent);
        if (cleaned !== node.textContent) node.textContent = cleaned;
    }
}

const SANITIZE_CONFIG = {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_ATTR: ['href', 'xlink:href', 'style'],
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_CONTENTS: ['script', 'foreignObject'],
};

// A DEDICATED DOMPurify instance (not the shared default used by markdownCore) so the SVG
// hardening hook below never contaminates the app's HTML sanitize pass, and vice versa. The
// rendered PlantUML SVG bypasses the markdown allowlist (it is injected via innerHTML), so it
// MUST get its own pass here.
let purifier: ReturnType<typeof DOMPurify> | null = null;

function getPurifier(): ReturnType<typeof DOMPurify> | null {
    if (purifier) return purifier;
    if (typeof window === 'undefined') return null;
    const instance = DOMPurify(window);
    instance.addHook('afterSanitizeAttributes', (node: Element) => hardenSvgNode(node));
    purifier = instance;
    return instance;
}

export function sanitizeSvg(svg: string): string {
    const instance = getPurifier();
    if (!instance || !instance.isSupported) return '';
    return String(instance.sanitize(svg, SANITIZE_CONFIG));
}
