// Development-only smoke test, active only when the main process loads the page
// with #selftest (DRIFT_SELFTEST=1). Drives the real UI through the M1 flow.
import { sensing } from './sensing/session';
import { runCycleTest } from './screens/DebugPanel';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function waitFor(id: string, ms = 10000): Promise<HTMLElement | null> {
    const end = performance.now() + ms;
    while (performance.now() < end) { const el = q(id); if (el) return el; await sleep(100); }
    return null;
}

function typeInto(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function installSelfTest() {
    (window as unknown as { __driftSelfTest: () => Promise<unknown> }).__driftSelfTest = async () => {
        const r: Record<string, unknown> = {};
        let getUserMediaCalls = 0;
        const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (c) => { getUserMediaCalls++; return orig(c); };

        r.consentShown = !!(await waitFor('consent-accept', 5000));
        r.cameraBeforeConsent = getUserMediaCalls;
        q('consent-accept')?.click();

        const input = await waitFor('key-input', 5000) as HTMLInputElement | null;
        r.keyScreen = !!input;
        if (input) {
            typeInto(input, 'selftest-dummy-key-123');
            await sleep(100);
            q('key-save')?.click();
        }
        r.cameraScreen = !!(await waitFor('camera-on', 8000));
        r.cameraBeforeClick = getUserMediaCalls;
        r.keyError = document.querySelector('[role="alert"]')?.textContent ?? null;

        q('camera-on')?.click();
        await sleep(9000);
        r.afterStart = {
            phase: sensing.phase,
            cameraOn: sensing.cameraOn,
            error: document.querySelector('[role="alert"]')?.textContent ?? null,
            pill: q('camera-pill')?.textContent,
        };
        await sensing.stop();
        r.cameraAfterStop = sensing.cameraOn;

        const cycles = await runCycleTest(3, () => {});
        r.cycles = cycles.map((c) => ({ n: c.n, released: c.cameraReleased, running: c.reachedRunning, error: c.error }));
        r.cameraAtEnd = sensing.cameraOn;
        return r;
    };
}
