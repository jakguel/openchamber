import { loadPlantUmlEngine } from '../../../src/components/chat/markdown/plantuml/loadEngine';
import { renderPlantuml } from '../../../src/components/chat/markdown/plantuml/renderPlantuml';
import { sanitizeSvg } from '../../../src/components/chat/markdown/plantuml/sanitizeSvg';

type SanitizeChecks = {
    blockedScript: boolean;
    blockedForeignObject: boolean;
    strippedRemoteImage: boolean;
    strippedRemoteUse: boolean;
    strippedRemoteUrl: boolean;
    preservedDataSprite: boolean;
    preservedFragmentUrl: boolean;
};

type HarnessResult = {
    done: boolean;
    engineLoaded: boolean;
    vizPresent: boolean;
    vizScriptCount: number;
    singleton: boolean;
    lightSig: string;
    darkSig: string;
    darkDiffersLight: boolean;
    invalidHasSvg: boolean;
    invalidError: string;
    c4HasSvg: boolean;
    c4IsError: boolean;
    stdlibPresent: boolean;
    stdlibScriptCount: number;
    sanitize: SanitizeChecks;
    error?: string;
};

const SEQUENCE = '@startuml\nAlice -> Bob : Hello\nBob --> Alice : ok\n@enduml';
const C4 = '@startuml\n!include <C4/C4_Context>\nPerson(user, "User")\nSystem(sys, "System")\nRel(user, sys, "Uses")\n@enduml';
const INVALID = '@startuml\ncomponent {\n!!! not valid <<<>>>\n@enduml';

const DIRTY_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
    '<script>window.__pwned=1</script>',
    '<foreignObject width="10" height="10"><div>escaped html</div></foreignObject>',
    '<image href="http://evil.example/track.png" width="10" height="10"/>',
    '<use xlink:href="https://evil.example/sprite.svg#s"/>',
    '<rect fill="url(http://evil.example/paint)" width="5" height="5"/>',
    '<image href="data:image/png;base64,iVBORw0KGgoAAAAN" width="10" height="10"/>',
    '<linearGradient id="g"><stop offset="0" stop-color="#000000"/></linearGradient>',
    '<rect fill="url(#g)" width="5" height="5"/>',
    '</svg>',
].join('');

const ERROR_SIGNATURE = /\$version\$|\[from [^\]]*line \d|fatal parsing error/i;

function colorSignature(svg: string): string {
    const colors = new Set<string>();
    const re = /(?:fill|stroke)(?::|=")\s*(#[0-9A-Fa-f]{3,8}|rgb\([^)]*\))/gi;
    for (let m = re.exec(svg); m !== null; m = re.exec(svg)) colors.add(m[1].toUpperCase());
    return `${svg.length}|${[...colors].sort().join(',')}`;
}

function setStatus(text: string): void {
    const el = document.getElementById('status');
    if (el) {
        el.textContent = text;
        el.setAttribute('data-status', text);
    }
}

function runSanitizeChecks(): SanitizeChecks {
    const out = sanitizeSvg(DIRTY_SVG);
    const lower = out.toLowerCase();
    return {
        blockedScript: !lower.includes('<script') && !out.includes('__pwned'),
        blockedForeignObject: !lower.includes('foreignobject') && !out.includes('escaped html'),
        strippedRemoteImage: !out.includes('evil.example/track'),
        strippedRemoteUse: !out.includes('evil.example/sprite'),
        strippedRemoteUrl: !out.includes('evil.example/paint') && !/url\(\s*['"]?https?:/i.test(out),
        preservedDataSprite: out.includes('data:image/png;base64,iVBORw0KGgoAAAAN'),
        preservedFragmentUrl: /url\(\s*#g\s*\)/.test(out),
    };
}

async function run(): Promise<void> {
    const result: Partial<HarnessResult> = { done: false };
    (window as unknown as { __result: Partial<HarnessResult> }).__result = result;

    try {
        setStatus('sanitize');
        result.sanitize = runSanitizeChecks();

        setStatus('load-engine');
        const [engineA, engineB] = await Promise.all([loadPlantUmlEngine(), loadPlantUmlEngine()]);
        result.engineLoaded = true;
        result.singleton = engineA === engineB;
        result.vizPresent = !!(globalThis as unknown as { Viz?: unknown }).Viz;
        result.vizScriptCount = document.querySelectorAll('script[data-plantuml-viz]').length;

        setStatus('render-light');
        const light = await renderPlantuml(SEQUENCE, false);
        setStatus('render-dark');
        const dark = await renderPlantuml(SEQUENCE, true);
        result.lightSig = light.svg ? colorSignature(light.svg) : '';
        result.darkSig = dark.svg ? colorSignature(dark.svg) : '';
        result.darkDiffersLight = !!light.svg && !!dark.svg && result.lightSig !== result.darkSig;

        setStatus('render-invalid');
        const invalid = await renderPlantuml(INVALID, false);
        result.invalidHasSvg = !!invalid.svg;
        result.invalidError = invalid.error ?? '';

        setStatus('render-c4');
        const c4 = await renderPlantuml(C4, false);
        result.c4HasSvg = !!c4.svg;
        result.c4IsError = !!c4.svg && ERROR_SIGNATURE.test(c4.svg);
        const w = window as unknown as {
            PLANTUML_STDLIB_JSON?: Record<string, unknown>;
            PLANTUML_STDLIB_INFO?: Record<string, unknown>;
        };
        result.stdlibPresent = !!w.PLANTUML_STDLIB_JSON?.c4 && !!w.PLANTUML_STDLIB_INFO?.c4;
        result.stdlibScriptCount = document.querySelectorAll('script[data-plantuml-stdlib="c4"]').length;

        result.done = true;
        setStatus('done');
    } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        result.done = true;
        setStatus('error');
    }
}

void run();
