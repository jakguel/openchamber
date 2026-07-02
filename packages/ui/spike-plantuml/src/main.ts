import { loadPlantUmlEngine, type PlantUmlEngine, type PlantUmlOptions } from './loadEngine';

type RenderResult = { hasSvg: boolean; svgLen: number; sig: string; isError: boolean; text: string };
type RtsResult = { ok: boolean; svgLen: number; sig: string; isError: boolean; error: string };

type SpikeResult = {
    done: boolean;
    loaderStrategy: string;
    vizPresent: boolean;
    engineLoaded: boolean;
    light: RenderResult;
    dark: RenderResult;
    darkDiffersLight: boolean;
    rtsLight: RtsResult;
    rtsDark: RtsResult;
    rtsDarkDiffersLight: boolean;
    rtsAcceptsDarkArg: boolean;
    c4: RenderResult;
    renderErr: RenderResult;
    rtsErr: RtsResult;
    error?: string;
};

const SEQUENCE = '@startuml\nAlice -> Bob : Hello\nBob --> Alice : ok\n@enduml';
const C4 = '@startuml\n!include <C4/C4_Context>\nPerson(user, "User")\nSystem(sys, "System")\nRel(user, sys, "Uses")\n@enduml';
// Unclosed `component {` — a syntax error PlantUML rejects, to exercise the error path.
const INVALID = '@startuml\ncomponent {\n!!! not valid <<<>>>\n@enduml';

// Dark mode recolors shapes/strokes/text, NOT the (transparent) background rect, so the
// discriminator is the sorted set of distinct fill/stroke colors, not one rect's fill.
function colorSignature(svg: string): string {
    const colors = new Set<string>();
    const re = /(?:fill|stroke)(?::|=")\s*(#[0-9A-Fa-f]{3,8}|rgb\([^)]*\))/gi;
    for (let m = re.exec(svg); m !== null; m = re.exec(svg)) colors.add(m[1].toUpperCase());
    return `${svg.length}|${[...colors].sort().join(',')}`;
}

// Empirically, a PlantUML SYNTAX error is NOT delivered via onError — both render() and
// renderToString(onSuccess) return an ERROR-DIAGRAM SVG (unresolved `$version$` footer +
// a `[From ...(line N)` source citation). So the only reliable error signal is scanning the
// emitted SVG/text for that signature.
function isPlantumlError(svgOrText: string): boolean {
    return /\$version\$|\[from [^\]]*line \d|syntax error|assumed diagram/i.test(svgOrText);
}

function lines(src: string): string[] {
    return src.split(/\r\n|\r|\n/);
}

function renderIntoHost(engine: PlantUmlEngine, src: string, hostId: string, opts?: PlantUmlOptions): Promise<RenderResult> {
    return new Promise((resolve) => {
        const host = document.getElementById(hostId);
        if (!host) {
            resolve({ hasSvg: false, svgLen: 0, sig: '', isError: false, text: 'no host' });
            return;
        }
        host.innerHTML = '';
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            observer.disconnect();
            clearTimeout(timer);
            const svg = host.querySelector('svg');
            const outer = svg ? svg.outerHTML : '';
            const text = svg ? (svg.textContent ?? '') : '';
            resolve({ hasSvg: !!svg, svgLen: outer.length, sig: colorSignature(outer), isError: isPlantumlError(outer) || isPlantumlError(text), text: text.slice(0, 200) });
        };
        const observer = new MutationObserver(() => {
            if (host.querySelector('svg')) finish();
        });
        observer.observe(host, { childList: true, subtree: true });
        // Bounded wait: an unrenderable source must resolve to an error affordance, never hang.
        const timer = setTimeout(finish, 20_000);
        try {
            engine.render(lines(src), hostId, opts);
        } catch {
            finish();
        }
    });
}

function renderToStringOnce(engine: PlantUmlEngine, src: string, opts?: PlantUmlOptions): Promise<RtsResult> {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ ok: false, svgLen: 0, sig: '', isError: true, error: 'TIMEOUT' });
        }, 20_000);
        const done = (r: RtsResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(r);
        };
        try {
            engine.renderToString(
                lines(src),
                (svg) => done({ ok: true, svgLen: svg.length, sig: colorSignature(svg), isError: isPlantumlError(svg), error: '' }),
                (msg) => done({ ok: false, svgLen: 0, sig: '', isError: true, error: msg || 'ERROR' }),
                opts,
            );
        } catch (e) {
            done({ ok: false, svgLen: 0, sig: '', isError: true, error: e instanceof Error ? e.message : String(e) });
        }
    });
}

function injectStdlib(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = false;
        s.addEventListener('load', () => resolve(), { once: true });
        s.addEventListener('error', () => reject(new Error(`stdlib load failed: ${url}`)), { once: true });
        document.head.appendChild(s);
    });
}

function setStatus(text: string): void {
    const el = document.getElementById('status');
    if (el) {
        el.textContent = text;
        el.setAttribute('data-status', text);
    }
}

async function run(): Promise<void> {
    const result: Partial<SpikeResult> = {
        done: false,
        loaderStrategy: 'script-tag(@plantuml/core/viz-global.js?url) THEN dynamic import(@plantuml/core/plantuml.js)',
    };
    (window as unknown as { __spikeResult: Partial<SpikeResult> }).__spikeResult = result;

    try {
        setStatus('loading-engine');
        const engine = await loadPlantUmlEngine();
        result.engineLoaded = true;
        result.vizPresent = !!(globalThis as unknown as { Viz?: unknown }).Viz;

        // Renders share the engine's mutable global state, so they MUST run one-at-a-time.
        setStatus('render-light');
        result.light = await renderIntoHost(engine, SEQUENCE, 'light-host');
        setStatus('render-dark');
        result.dark = await renderIntoHost(engine, SEQUENCE, 'dark-host', { dark: true });
        result.darkDiffersLight = !!result.light && !!result.dark && result.dark.hasSvg && result.light.sig !== result.dark.sig;

        setStatus('rts-light');
        result.rtsLight = await renderToStringOnce(engine, SEQUENCE);
        setStatus('rts-dark');
        result.rtsDark = await renderToStringOnce(engine, SEQUENCE, { dark: true });
        result.rtsDarkDiffersLight = !!result.rtsLight?.ok && !!result.rtsDark?.ok && result.rtsLight.sig !== result.rtsDark.sig;
        result.rtsAcceptsDarkArg = result.rtsDarkDiffersLight;

        setStatus('c4-stdlib');
        try {
            await injectStdlib('/c4.min.js');
            result.c4 = await renderIntoHost(engine, C4, 'c4-host');
        } catch (e) {
            result.c4 = { hasSvg: false, svgLen: 0, sig: '', isError: true, text: e instanceof Error ? e.message : String(e) };
        }

        setStatus('render-invalid');
        result.renderErr = await renderIntoHost(engine, INVALID, 'err-host');
        setStatus('rts-invalid');
        result.rtsErr = await renderToStringOnce(engine, INVALID);

        result.done = true;
        setStatus('done');
    } catch (e) {
        result.error = e instanceof Error ? e.message : String(e);
        result.done = true;
        setStatus('error');
    }
}

void run();
