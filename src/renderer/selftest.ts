// Development-only smoke test, active only when the main process loads the page
// with #selftest (DRIFT_SELFTEST=1). Drives the real UI through the M1 flow.
import { sensing } from './sensing/session';
import { runCycleTest } from './screens/DebugPanel';
import { tracker, trackerNow } from './usePresence';
import { engine } from './screens/Player';

const shot = async (name: string) => { console.log(`[shot] ${name}`); await sleep(600); };
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
        await shot('1-welcome');
        q('consent-accept')?.click();

        const input = await waitFor('key-input', 5000) as HTMLInputElement | null;
        r.keyScreen = !!input;
        if (input) {
            await shot('2-key');
            typeInto(input, 'selftest-dummy-key-123');
            await sleep(100);
            q('key-save')?.click();
        }
        r.cameraScreen = !!(await waitFor('camera-on', 8000));
        r.cameraBeforeClick = getUserMediaCalls;
        r.keyError = document.querySelector('[role="alert"]')?.textContent ?? null;

        q('camera-on')?.click();
        await sleep(9000);
        await shot('3-camera-check');
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
        r.player = await playerTest();
        return r;
    };
}

/** Records a short WebM lecture from a canvas so the player has something to play. */
async function makeTestVideo(seconds: number): Promise<File> {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 180;
    const g = c.getContext('2d')!;
    const stream = c.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const t0 = performance.now();
    const draw = setInterval(() => {
        const s = (performance.now() - t0) / 1000;
        g.fillStyle = '#223'; g.fillRect(0, 0, 320, 180);
        g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText(`lecture ${s.toFixed(1)}`, 20, 100);
    }, 33);
    rec.start(250);
    await sleep(seconds * 1000);
    rec.stop();
    clearInterval(draw);
    await new Promise((r) => (rec.onstop = r));
    return new File(chunks, 'test-lecture.webm', { type: 'video/webm' });
}

/** Feeds synthetic face frames at 30 Hz: eye openness `ear`, landmarks always moving. */
async function feedFace(ear: number, ms: number) {
    const end = performance.now() + ms;
    let i = 0;
    while (performance.now() < end) {
        const t = trackerNow();
        tracker.feedLandmarks(t, ear + (i++ % 2) * 0.001, 0.01);
        tracker.feedBlinkSample(t);
        await sleep(33);
    }
}

async function playerTest() {
    const r: Record<string, unknown> = {};
    const w = window as unknown as { __driftGoto: (s: string) => void; __driftFakeSession?: boolean };
    w.__driftGoto('player');
    const input = (await waitFor('file-input', 5000)) as HTMLInputElement | null;
    r.openScreen = !!input;
    if (!input) return r;
    await shot('4-open-lecture');

    const file = await makeTestVideo(12);
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const video = (await waitFor('video', 5000)) as HTMLVideoElement | null;
    r.videoLoaded = !!video;
    if (!video) return r;

    w.__driftFakeSession = true;
    tracker.setBaseline(0.22);
    video.muted = true;
    await video.play().catch((e) => { r.playError = String(e); });
    await feedFace(0.22, 2500);                 // watching
    r.pausedBeforeClosure = video.paused;
    const closeAtVideo = video.currentTime;
    const t0 = performance.now();
    const cardPromise = waitFor('drift-card', 6000);
    void feedFace(0.05, 3800);                  // eyes closed 3.8 s
    const card = await cardPromise;
    r.cardShown = !!card;
    r.cardAfterS = +((performance.now() - t0) / 1000).toFixed(2);
    r.videoPausedByDrift = video.paused;
    r.cardText = card?.textContent;
    await shot('5-drift-card');
    r.closeAtVideo = +closeAtVideo.toFixed(2);
    r.onsetVideo = engine.drifts[0] ? +engine.drifts[0].onsetVideo.toFixed(2) : null;
    await sleep(1500);
    await feedFace(0.22, 1500);                 // back, eyes open
    q('card-rewind')?.click();
    await sleep(300);
    r.afterRewind = { time: +video.currentTime.toFixed(2), rewindTo: engine.drifts[0]?.rewindTo, playing: !video.paused, cardGone: !q('drift-card') };
    r.markers = document.querySelectorAll('.track .marker').length;
    await shot('6-playing-with-marker');

    // Switching screens must not restart the lecture.
    await sleep(1200);
    const posBefore = video.currentTime;
    w.__driftGoto('settings');
    await sleep(800);
    await shot('8-settings');
    w.__driftGoto('player');
    const v2 = (await waitFor('video', 3000)) as HTMLVideoElement | null;
    await sleep(800);
    r.positionKept = v2 ? { before: +posBefore.toFixed(2), after: +v2.currentTime.toFixed(2) } : null;
    if (v2) { v2.muted = true; await v2.play().catch(() => {}); }
    const vid = v2 ?? video;

    // Looking down (no face data) must not pause.
    const before = engine.drifts.length;
    await sleep(3000);
    r.noPauseWithoutFace = { pausedNow: vid.paused, newDrifts: engine.drifts.length - before };

    q('end')?.click();
    r.summary = (await waitFor('summary-title', 3000))?.textContent ?? null;
    await shot('7-summary');
    w.__driftFakeSession = false;
    return r;
}
