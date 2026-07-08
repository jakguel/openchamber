// Real-renderer harness for story openchamber-5ki.44 (T6). Drives the PRODUCTION error-surfacing
// path end-to-end in real Chromium: the real @plantuml/core engine (loadEngine) -> renderPlantuml
// -> extractPlantumlError wiring (T4), plus the real render queue (negative cache) and the real
// cache-key builder. NOTHING under src/ is mocked or faked — the only wrapper is a call counter
// around the REAL renderPlantuml (exactly the shape production's createPlantumlQueue uses), used
// to observe whether the negative cache served a hit vs. re-ran the real render.
import { renderPlantuml } from '../../../src/components/chat/markdown/plantuml/renderPlantuml';
import { createPlantumlRenderQueue } from '../../../src/components/chat/markdown/plantuml/renderQueue';
import { buildPlantumlCacheKey } from '../../../src/components/chat/markdown/plantuml/cacheKey';

// The exact invalid snippet captured by the T1 fixtures: `diamond` does not accept a quoted display
// label, so the real 1.2026.6 engine cites line 3 with the offending token below.
const INVALID = '@startuml\nrectangle "Box" as R\ndiamond "some label" as X\nR --> X\n@enduml';
// Same block, corrected: `diamond` -> `rectangle` makes it a valid diagram (different cache key).
const CORRECTED = '@startuml\nrectangle "Box" as R\nrectangle "some label" as X\nR --> X\n@enduml';
// An unrelated valid diagram (success path).
const VALID = '@startuml\nAlice -> Bob : Hello\nBob --> Alice : ok\n@enduml';

// T6d candidates for the generic-fallback path. The real 1.2026.6 engine cites a `[From ... (line
// N)]` on EVERY error diagram, so a syntax error never reaches the no-citation fallback. The path
// that IS reachable on the real engine is the false-positive / format-drift one: a VALID diagram
// whose label text trips the content-based isPlantumlError signature yet has NO citation, so
// extractPlantumlError returns null and renderPlantuml returns the generic constant (never a stray
// detail or a stack trace). The winning candidate is asserted by the e2e.
const FALLBACK_CONSTANT = 'Invalid PlantUML diagram source';
const DRIFT_CANDIDATES: Array<{ id: string; source: string }> = [
    // False-positive / format-drift: a VALID diagram whose label text trips the content-based
    // isPlantumlError signature (e.g. the literal phrase "syntax error"), yet carries NO
    // `[From ... (line N)]` citation — so extractPlantumlError returns null and renderPlantuml
    // returns the generic constant instead of a stray detail. This is the exact defensive path
    // renderPlantuml documents ("a format drift or false-positive NEVER masks ...").
    { id: 'fp-note-syntax-error', source: '@startuml\nnote "syntax error" as N\n@enduml' },
    { id: 'fp-msg-syntax-error', source: '@startuml\nAlice -> Bob : syntax error\n@enduml' },
    { id: 'fp-note-assumed-diagram', source: '@startuml\nnote "assumed diagram" as N\n@enduml' },
    // Structural probes retained for diagnostics (real engine still cites a line for these).
    { id: 'missing-include', source: '@startuml\n!include does-not-exist-xyzzy.iuml\n@enduml' },
    { id: 'bare-text', source: 'this is not a plantuml diagram at all' },
];

type DriftProbe = {
    id: string;
    error: string;
    hasSvg: boolean;
    threw: boolean;
    isFallback: boolean;
};

type HarnessResult = {
    done: boolean;

    // AC-T6a — invalid snippet surfaces the EXACT offending token + line (no theme).
    invalidError: string;
    invalidHasSvg: boolean;

    // AC-T6b — a valid snippet renders an SVG.
    validHasSvg: boolean;
    validIsSvg: boolean;

    // AC-T6c — corrected source re-renders past the 5-min negative cache (new cache key).
    negFirstError: string;
    negCachedError: string;
    correctedHasSvg: boolean;
    correctedError: string;
    correctedKeyDiffers: boolean;
    callsAfterFirst: number; // 1 after the first (real) invalid render
    callsAfterCached: number; // still 1: the negative cache served the repeat (no re-render)
    callsAfterCorrected: number; // 2: the corrected source (new key) actually re-rendered

    // AC-T6d — no-citation / malformed / drift input falls back to the constant (no throw).
    drift: DriftProbe[];
    driftFallbackId: string; // id of the first candidate that hit the constant with no throw
    driftFallbackError: string;
    driftFallbackHasSvg: boolean;
    driftFallbackThrew: boolean;

    error?: string;
};

function isSvgMarkup(svg: string | undefined): boolean {
    return typeof svg === 'string' && /^\s*<svg[\s>]/i.test(svg);
}

function setStatus(text: string): void {
    const el = document.getElementById('status');
    if (el) {
        el.textContent = text;
        el.setAttribute('data-status', text);
    }
}

async function run(): Promise<void> {
    const result: Partial<HarnessResult> = { done: false };
    (window as unknown as { __result: Partial<HarnessResult> }).__result = result;

    try {
        // AC-T6a — real render of the invalid snippet, no theme -> exact line/token surfaced.
        setStatus('render-invalid');
        const invalid = await renderPlantuml(INVALID, false, '');
        result.invalidHasSvg = !!invalid.svg;
        result.invalidError = invalid.error ?? '';

        // AC-T6b — a valid snippet renders a real SVG.
        setStatus('render-valid');
        const valid = await renderPlantuml(VALID, false, '');
        result.validHasSvg = !!valid.svg;
        result.validIsSvg = isSvgMarkup(valid.svg);

        // AC-T6c — drive the REAL queue (real negative cache + real cache key). The render fn is the
        // REAL renderPlantuml; the counter only OBSERVES whether a re-render happened.
        setStatus('render-negative-cache');
        let calls = 0;
        const queue = createPlantumlRenderQueue({
            render: (_key, source, dark, themeBody) => {
                calls += 1;
                return renderPlantuml(source, dark, themeBody);
            },
        });
        // Mirror production's cache-key slot (buildPlantumlCacheKey appends the source verbatim, so
        // editing the source yields a DIFFERENT key — the property that lets the corrected source
        // escape the negative cache).
        const slot = { themeId: 'light', plantumlTheme: 'none', dark: false };
        const keyInvalid = buildPlantumlCacheKey(slot, INVALID);
        const keyCorrected = buildPlantumlCacheKey(slot, CORRECTED);
        result.correctedKeyDiffers = keyInvalid !== keyCorrected;
        // morphdom reuses ONE live block node across a source edit — model that with a single node.
        const node = { isConnected: true };

        const first = await queue.enqueue(keyInvalid, INVALID, false, '', node).promise;
        result.negFirstError = first.error ?? '';
        result.callsAfterFirst = calls;

        // Same key again -> served from the negative cache, the real render MUST NOT run again.
        const cached = await queue.enqueue(keyInvalid, INVALID, false, '', node).promise;
        result.negCachedError = cached.error ?? '';
        result.callsAfterCached = calls;

        // Corrected source -> NEW cache key -> a fresh real render, NOT the stale cached error.
        const corrected = await queue.enqueue(keyCorrected, CORRECTED, false, '', node).promise;
        result.correctedHasSvg = !!corrected.svg;
        result.correctedError = corrected.error ?? '';
        result.callsAfterCorrected = calls;

        // AC-T6d — probe drift candidates; capture the first that falls back to the constant.
        setStatus('render-drift');
        const drift: DriftProbe[] = [];
        for (const candidate of DRIFT_CANDIDATES) {
            let error = '';
            let hasSvg = false;
            let threw = false;
            try {
                const out = await renderPlantuml(candidate.source, false, '');
                error = out.error ?? '';
                hasSvg = !!out.svg;
            } catch {
                threw = true;
            }
            drift.push({ id: candidate.id, error, hasSvg, threw, isFallback: error === FALLBACK_CONSTANT });
        }
        result.drift = drift;
        const fallback = drift.find((d) => d.isFallback && !d.threw && !d.hasSvg);
        result.driftFallbackId = fallback?.id ?? '';
        result.driftFallbackError = fallback?.error ?? '';
        result.driftFallbackHasSvg = fallback?.hasSvg ?? false;
        result.driftFallbackThrew = fallback?.threw ?? false;

        result.done = true;
        setStatus('done');
    } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        result.done = true;
        setStatus('error');
    }
}

void run();
