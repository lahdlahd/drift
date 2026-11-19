// Drift M0 probe — renderer. Bundled by esbuild into dist/renderer.bundle.js.
'use strict';

const {
    SmartSpectraSDK, ProcessingStatus, ValidationCode, faceMetrics, breathingMetrics,
} = require('@smartspectra/node-sdk/renderer');
const { decodeMetrics } = require('@smartspectra/node-sdk/messages');
const { TRIALS, actionSeconds, trialTotalSeconds, tsToNumber, earFromLandmarks } = require('./lib/core');

const $ = (id) => document.getElementById(id);
const els = {
    key: $('api-key'), faceOnly: $('face-only'),
    start: $('btn-start'), stop: $('btn-stop'), save: $('btn-save'),
    runAll: $('btn-run-all'), abort: $('btn-abort'),
    error: $('error'), preview: $('preview'),
    eye: $('eye-state'), proc: $('proc'), val: $('val'), fps: $('fps'), bps: $('bps'), ear: $('ear'),
    count: $('count'), trials: $('trials'), instruction: $('instruction'),
    fastExp: $('fast-exp'), res: $('res'), camCheckBtn: $('btn-camcheck'), camCheck: $('camcheck'), camfps: $('camfps'),
};

// ---- Camera (the probe owns the stream so it can choose the resolution) ----
let stream = null;
let camFrames = 0;
let rvfcActive = false;
let rvfcGen = 0;

async function openStream() {
    const [w, h] = els.res.value.split('x').map(Number);
    const st = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } },
    });
    lastExposure = await applyExposure(st.getVideoTracks()[0]);
    return st;
}

// Webcams lengthen exposure in dim light, which halves the frame rate (30 -> 15 fps).
// If the camera exposes manual exposure (Chromium: exposureTime in 100 µs units),
// cap it at one frame period (1/30 s = 333) so 30 fps is possible.
let lastExposure = null;
const camChecks = [];
async function applyExposure(track) {
    const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
    const info = {
        exposureModes: caps.exposureMode || [],
        exposureTime: caps.exposureTime || null,
        frameRate: caps.frameRate || null,
        brightness: caps.brightness || null,
        applied: null,
    };
    if (!els.fastExp.checked) return info;
    if (!info.exposureModes.includes('manual') || !info.exposureTime) {
        info.applied = 'not supported by this webcam';
        return info;
    }
    const target = Math.max(info.exposureTime.min, Math.min(info.exposureTime.max, 300));
    try {
        await track.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime: target }] });
        info.applied = `manual exposure ${target} (x100 µs)`;
    } catch (e) {
        info.applied = `failed: ${e.name} ${e.message}`;
    }
    return info;
}

function exposureNote() {
    if (!lastExposure) return '';
    if (!els.fastExp.checked) {
        return lastExposure.exposureModes.includes('manual') ? ' Fast exposure is available: tick it and check again.' : ' This webcam does not offer manual exposure.';
    }
    return ` Fast exposure: ${lastExposure.applied}.`;
}

function closeStream() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
}

// Count frames the camera actually delivers to the page, independent of the SDK.
function countCameraFrames(video) {
    // One counting chain at a time: a new generation silently ends any older chain.
    rvfcActive = true;
    const gen = ++rvfcGen;
    const tick = () => {
        if (!rvfcActive || gen !== rvfcGen) return;
        camFrames++;
        video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
}

async function checkCameraSpeed() {
    if (sdk) return;
    els.camCheckBtn.disabled = true;
    els.camCheck.textContent = 'Measuring for 6 seconds…';
    try {
        stream = await openStream();
        els.preview.srcObject = stream;
        await els.preview.play().catch(() => {});
        camFrames = 0;
        countCameraFrames(els.preview);
        await new Promise((r) => setTimeout(r, 1000));   // let exposure settle
        camFrames = 0;
        await new Promise((r) => setTimeout(r, 5000));
        rvfcActive = false;
        const fps = camFrames / 5;
        const s = stream.getVideoTracks()[0].getSettings();
        els.camCheck.textContent =
            `Camera delivers ${fps.toFixed(1)} frames/s at ${s.width}×${s.height} (camera reports a ${Math.round(s.frameRate ?? 0)} fps mode). ` +
            (fps >= 25 ? 'Good.' : fps >= 20 ? 'Borderline: add light in front of you.' : 'Too low: add light in front of you, plug in the charger, then check again.') +
            exposureNote();
        camChecks.push({ t: nowUs(), fps, fastExposure: els.fastExp.checked, settings: s, exposure: lastExposure });
    } catch (e) {
        els.camCheck.textContent = `Camera error: ${e.name} ${e.message}`;
    } finally {
        rvfcActive = false;
        closeStream();
        els.preview.srcObject = null;
        els.camCheckBtn.disabled = false;
    }
}

const STATUS_NAMES = Object.fromEntries(Object.entries(ProcessingStatus).map(([k, v]) => [v, k.replace(/^k/, '')]));
const VAL_NAMES = Object.fromEntries(Object.entries(ValidationCode).map(([k, v]) => [v, k.replace(/^k/, '')]));

const nowUs = () => Date.now() * 1000;

// ---- Log ------------------------------------------------------------------
let log = null;
let autoSaved = false;
function newLog() {
    autoSaved = false;
    log = {
        meta: {
            probe: 'drift-m0-probe 0.1.0',
            sdkVersion: SmartSpectraSDK.version,
            startedAt: new Date().toISOString(),
            userAgent: navigator.userAgent,
            faceOnly: els.faceOnly.checked,
            telemetry: false,
            camChecks,
        },
        schemaSamples: [],   // first few decoded face payloads, landmarks trimmed
        events: [],
    };
}
function push(ev) {
    log.events.push(ev);
    if (log.events.length % 25 === 0) els.count.textContent = String(log.events.length);
}

function showError(msg) {
    els.error.hidden = false;
    els.error.textContent = msg;
}

// ---- Rates ----------------------------------------------------------------
let framesSent = 0, framesDropped = 0, blinkSamples = 0;
let rateTimer = null;
function startRates() {
    rateTimer = setInterval(() => {
        els.fps.textContent = `${framesSent} sent, ${framesDropped} dropped`;
        els.camfps.textContent = String(camFrames);
        els.bps.textContent = String(blinkSamples);
        push({ type: 'rate', t: nowUs(), cam: camFrames, sent: framesSent, dropped: framesDropped, blink: blinkSamples });
        framesSent = 0; framesDropped = 0; blinkSamples = 0; camFrames = 0;
    }, 1000);
}

// ---- SDK ------------------------------------------------------------------
let sdk = null;

function handleMetrics(m) {
    const face = m.face;
    if (!face) return;
    if (log.schemaSamples.length < 3) {
        const s = JSON.parse(JSON.stringify(face, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
        if (Array.isArray(s.landmarks)) {
            s.landmarks = s.landmarks.slice(0, 1).map((l) => ({ ...l, value: `[${(l.value || []).length} points]` }));
        }
        if (Array.isArray(s.expression)) s.expression = s.expression.slice(0, 1);
        log.schemaSamples.push(s);
    }
    for (const b of face.blinking || []) {
        blinkSamples++;
        push({ type: 'blink', t: tsToNumber(b.timestamp), detected: !!b.detected, stable: !!b.stable });
        els.eye.textContent = b.detected ? 'Eyes: CLOSED' : 'Eyes: open';
        els.eye.className = b.detected ? 'big closed' : 'big';
    }
    for (const l of face.landmarks || []) {
        const e = earFromLandmarks(l.value);
        if (e) {
            push({ type: 'ear', t: tsToNumber(l.timestamp), l: +e.left.toFixed(4), r: +e.right.toFixed(4), stable: !!l.stable });
            els.ear.textContent = e.mean.toFixed(3);
        } else if ((l.value || []).length) {
            push({ type: 'ear-skip', t: tsToNumber(l.timestamp), n: l.value.length });
        }
    }
    for (const tk of face.talking || []) {
        push({ type: 'talk', t: tsToNumber(tk.timestamp), detected: !!tk.detected });
    }
}

async function startCamera() {
    els.error.hidden = true;
    const apiKey = els.key.value.trim();
    if (!apiKey) { showError('Paste your Presage API key first.'); return; }
    newLog();
    els.start.disabled = true;
    els.camCheckBtn.disabled = true;
    log.meta.resolution = els.res.value;
    const requested = els.faceOnly.checked ? [...faceMetrics] : [...breathingMetrics, ...faceMetrics];
    log.meta.requestedMetrics = requested;

    sdk = new SmartSpectraSDK({
        apiKey,
        requestedMetrics: requested,
        enableAccumulatedOutput: false,
        enableTelemetry: false,
    });
    sdk.on('processingStatus', (s) => {
        const name = STATUS_NAMES[s] || `Status(${s})`;
        els.proc.textContent = name;
        push({ type: 'status', t: nowUs(), status: name });
        // On a terminal error, release the camera instead of pumping frames into a dead session.
        if (s === ProcessingStatus.kError) setTimeout(() => { if (sdk) stopCamera(); }, 0);
        const running = s === ProcessingStatus.kRunning;
        els.runAll.disabled = !running || runningTrial;
        document.querySelectorAll('.trial button').forEach((b) => { b.disabled = !running || runningTrial; });
    });
    sdk.on('validationStatus', (code, ts, hint) => {
        const name = VAL_NAMES[code] || `Code(${code})`;
        els.val.textContent = hint ? `${name} — ${hint}` : name;
        push({ type: 'val', t: Number(ts) || nowUs(), code, name, hint: hint || '' });
    });
    sdk.on('frameSentThrough', (sent) => { if (sent) framesSent++; else framesDropped++; });
    sdk.on('metrics', (buf) => {
        try { handleMetrics(decodeMetrics(buf)); } catch (e) { push({ type: 'decode-error', t: nowUs(), msg: String(e) }); }
    });
    sdk.on('error', (code, message, retryable) => {
        push({ type: 'error', t: nowUs(), code, message, retryable });
        showError(`SDK error ${code}${retryable ? ' (retryable)' : ''}: ${message}\nThe log was saved automatically, so you can send it.`);
        if (!autoSaved) { autoSaved = true; saveLog(); }
    });

    try {
        stream = await openStream();
        const track = stream.getVideoTracks()[0];
        push({ type: 'camera', t: nowUs(), label: track.label, settings: track.getSettings(), exposure: lastExposure });
        sdk.useMediaStream(stream);
        els.preview.srcObject = stream;
        els.preview.play().catch(() => {});
        camFrames = 0;
        countCameraFrames(els.preview);
        startRates();
        await sdk.start();
        els.stop.disabled = false;
        els.save.disabled = false;
        els.instruction.textContent = 'Camera running. Run the tests in order, or one at a time.';
    } catch (err) {
        push({ type: 'start-error', t: nowUs(), code: err.code ?? null, message: err.message });
        showError(`Could not start: ${err.code ?? ''} ${err.name ?? ''} ${err.message}`);
        try { if (sdk) sdk.destroy(); } catch { /* ignore */ }
        sdk = null;
        clearInterval(rateTimer);
        rvfcActive = false;
        closeStream();
        els.preview.srcObject = null;
        els.start.disabled = false;
        els.camCheckBtn.disabled = false;
        els.save.disabled = false;
        if (!autoSaved) { autoSaved = true; saveLog(); }
    }
}

async function stopCamera() {
    abortTrial = true;
    els.stop.disabled = true;
    clearInterval(rateTimer);
    try { if (sdk) await sdk.stop(); } catch (e) { push({ type: 'stop-error', t: nowUs(), message: String(e) }); }
    if (sdk) { try { sdk.destroy(); } catch { /* ignore */ } }
    sdk = null;
    rvfcActive = false;
    closeStream();
    els.preview.srcObject = null;
    els.start.disabled = false;
    els.camCheckBtn.disabled = false;
    els.runAll.disabled = true;
    els.proc.textContent = 'Stopped';
    els.instruction.textContent = 'Camera stopped. Save the log and send it over.';
}

function saveLog() {
    if (!log) return;
    log.meta.savedAt = new Date().toISOString();
    const blob = new Blob([JSON.stringify(log)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `drift-m0-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---- Tests ----------------------------------------------------------------
let audio = null;
function beep(freq, ms, at = 0) {
    audio = audio || new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq;
    g.gain.value = 0.25;
    o.connect(g).connect(audio.destination);
    const t0 = audio.currentTime + at;
    o.start(t0); o.stop(t0 + ms / 1000);
}
const cueAction = () => beep(880, 250);
const cueBack = () => { beep(523, 150); beep(523, 150, 0.25); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let runningTrial = false;
let abortTrial = false;

async function countdown(label, seconds) {
    for (let s = seconds; s > 0; s--) {
        if (abortTrial) return;
        els.instruction.textContent = `${label} — ${s}`;
        await sleep(1000);
    }
}

async function runTrial(trial) {
    const card = document.getElementById(`trial-${trial.id}`);
    card.classList.add('running');
    els.instruction.textContent = trial.say;
    push({ type: 'mark', t: nowUs(), trial: trial.id, phase: 'trial-start' });
    await sleep(4000);
    await countdown('Get ready', 3);
    for (let rep = 0; rep < trial.reps && !abortTrial; rep++) {
        const secs = actionSeconds(trial, rep);
        cueAction();
        push({ type: 'mark', t: nowUs(), trial: trial.id, rep, phase: 'action-start', expect: trial.expect, durationS: secs });
        await countdown(`${trial.name} (${rep + 1}/${trial.reps})`, secs);
        cueBack();
        push({ type: 'mark', t: nowUs(), trial: trial.id, rep, phase: 'action-end', expect: trial.expect, durationS: secs });
        if (trial.restS) await countdown('Back to normal', trial.restS);
    }
    push({ type: 'mark', t: nowUs(), trial: trial.id, phase: abortTrial ? 'trial-aborted' : 'trial-end' });
    card.classList.remove('running');
    if (!abortTrial) card.classList.add('done');
}

async function runTrials(list) {
    if (runningTrial) return;
    runningTrial = true; abortTrial = false;
    els.runAll.disabled = true; els.abort.disabled = false;
    document.querySelectorAll('.trial button').forEach((b) => { b.disabled = true; });
    for (const t of list) {
        if (abortTrial) break;
        await runTrial(t);
    }
    runningTrial = false;
    els.abort.disabled = true;
    const live = !!sdk;
    els.runAll.disabled = !live;
    document.querySelectorAll('.trial button').forEach((b) => { b.disabled = !live; });
    els.instruction.textContent = abortTrial ? 'Test aborted.' : 'Tests finished. Click Save log, then Stop camera.';
}

function renderTrials() {
    for (const t of TRIALS) {
        const div = document.createElement('div');
        div.className = 'trial';
        div.id = `trial-${t.id}`;
        const mins = Math.ceil(trialTotalSeconds(t) / 60);
        div.innerHTML = `<div class="name"></div><div class="muted"></div>`;
        div.querySelector('.name').textContent = t.name;
        div.querySelector('.muted').textContent = `${t.reps} × · about ${mins} min`;
        const b = document.createElement('button');
        b.textContent = 'Run';
        b.disabled = true;
        b.addEventListener('click', () => runTrials([t]));
        div.appendChild(b);
        els.trials.appendChild(div);
    }
}

els.start.addEventListener('click', startCamera);
els.camCheckBtn.addEventListener('click', checkCameraSpeed);
els.stop.addEventListener('click', stopCamera);
els.save.addEventListener('click', saveLog);
els.runAll.addEventListener('click', () => runTrials(TRIALS));
els.abort.addEventListener('click', () => { abortTrial = true; });
window.addEventListener('beforeunload', () => { if (sdk) { try { sdk.destroy(); } catch { /* ignore */ } } closeStream(); });

renderTrials();
