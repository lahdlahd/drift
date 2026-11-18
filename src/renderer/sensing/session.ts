// SensingSession: owns the camera stream and the SmartSpectra SDK for one session.
// Drift opens the camera itself (640×480 at 30 fps, which M0 showed the Dell webcam
// sustains in good light) and hands the stream to the SDK. Only face metrics are
// requested and SDK telemetry is off. Nothing here records or stores video.
import {
    SmartSpectraSDK, ProcessingStatus, ValidationCode, faceMetrics,
} from '@smartspectra/node-sdk/renderer';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';
import { eyeOpenness, type Point } from './ear';

export type SessionPhase = 'off' | 'starting' | 'running' | 'stopping' | 'error';

export interface ValidationInfo { code: number; name: string; hint: string; t: number }
export interface SessionError { code: number | string; message: string; retryable: boolean }
export interface Rates { camera: number; sent: number; dropped: number; blink: number; landmarks: number }

export interface SessionEvents {
    phase: (p: SessionPhase) => void;
    validation: (v: ValidationInfo) => void;
    landmarks: (t: number, ear: number | null, fingerprint: number) => void;
    blink: (t: number) => void;
    rates: (r: Rates) => void;
    error: (e: SessionError) => void;
}

const VALIDATION_NAMES: Record<number, string> = Object.fromEntries(
    Object.entries(ValidationCode).map(([k, v]) => [v as number, k.replace(/^k/, '')]),
);
export const validationName = (code: number) => VALIDATION_NAMES[code] ?? `Code${code}`;

function tsToNumber(ts: unknown): number {
    if (ts == null) return 0;
    if (typeof ts === 'number') return ts;
    if (typeof ts === 'bigint') return Number(ts);
    const maybeLong = ts as { toNumber?: () => number };
    return typeof maybeLong.toNumber === 'function' ? maybeLong.toNumber() : Number(ts);
}

/** Cheap fingerprint: changes whenever any of a spread of landmarks moves. */
function fingerprint(points: readonly Point[]): number {
    let f = 0;
    for (let i = 0; i < points.length; i += 37) {
        const p = points[i];
        if (p) f = (f * 31 + (p.x ?? 0) * 1000 + (p.y ?? 0) * 7919) % 1e12;
    }
    return f;
}

type Listener<K extends keyof SessionEvents> = SessionEvents[K];

export class SensingSession {
    private sdk: SmartSpectraSDK | null = null;
    private stream: MediaStream | null = null;
    private frameVideo: HTMLVideoElement | null = null;
    private rateTimer: ReturnType<typeof setInterval> | null = null;
    private counts = { camera: 0, sent: 0, dropped: 0, blink: 0, landmarks: 0 };
    private gen = 0;
    private listeners: { [K in keyof SessionEvents]: Set<Listener<K>> } = {
        phase: new Set(), validation: new Set(), landmarks: new Set(), blink: new Set(), rates: new Set(), error: new Set(),
    };
    private _phase: SessionPhase = 'off';
    lastValidation: ValidationInfo | null = null;
    lastRates: Rates | null = null;

    get phase(): SessionPhase { return this._phase; }
    get mediaStream(): MediaStream | null { return this.stream; }
    get cameraOn(): boolean { return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live'); }

    on<K extends keyof SessionEvents>(event: K, fn: SessionEvents[K]): () => void {
        (this.listeners[event] as Set<SessionEvents[K]>).add(fn);
        return () => { (this.listeners[event] as Set<SessionEvents[K]>).delete(fn); };
    }

    private emit<K extends keyof SessionEvents>(event: K, ...args: Parameters<SessionEvents[K]>) {
        for (const fn of this.listeners[event] as Set<(...a: Parameters<SessionEvents[K]>) => void>) {
            try { fn(...args); } catch (e) { console.error('[drift] listener error', e); }
        }
    }

    private setPhase(p: SessionPhase) {
        if (this._phase === p) return;
        this._phase = p;
        this.emit('phase', p);
    }

    /** Opens the camera only. Used by the camera check before any SDK credits are spent. */
    async openCamera(): Promise<MediaStream> {
        if (this.stream && this.cameraOn) return this.stream;
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
        });
        this.startFrameCounter();
        return this.stream;
    }

    /** Measures frames per second actually delivered by the camera. */
    async measureCameraFps(ms = 5000): Promise<number> {
        await this.openCamera();
        await new Promise((r) => setTimeout(r, 800)); // let exposure settle
        const before = this.totalFrames;
        const t0 = performance.now();
        await new Promise((r) => setTimeout(r, ms));
        return ((this.totalFrames - before) * 1000) / (performance.now() - t0);
    }

    private totalFrames = 0;
    private startFrameCounter() {
        const gen = ++this.gen;
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.srcObject = this.stream;
        this.frameVideo = v;
        void v.play().catch(() => {});
        const tick = () => {
            if (gen !== this.gen || !this.stream) return;
            this.totalFrames++;
            this.counts.camera++;
            v.requestVideoFrameCallback(tick);
        };
        v.requestVideoFrameCallback(tick);
        if (this.rateTimer) clearInterval(this.rateTimer);
        this.rateTimer = setInterval(() => {
            this.lastRates = { ...this.counts };
            this.emit('rates', this.lastRates);
            this.counts = { camera: 0, sent: 0, dropped: 0, blink: 0, landmarks: 0 };
        }, 1000);
    }

    async start(apiKey: string): Promise<void> {
        if (this.sdk) return;
        this.setPhase('starting');
        try {
            const stream = await this.openCamera();
            const sdk = new SmartSpectraSDK({
                apiKey,
                requestedMetrics: [...faceMetrics],
                enableAccumulatedOutput: false,
                enableTelemetry: false,
            });
            this.sdk = sdk;
            sdk.on('processingStatus', (s) => {
                if (s === ProcessingStatus.kRunning) this.setPhase('running');
                else if (s === ProcessingStatus.kError) {
                    // Terminal error: release the camera instead of feeding a dead session.
                    this.setPhase('error');
                    setTimeout(() => { void this.stop(); }, 0);
                }
            });
            sdk.on('validationStatus', (code, ts, hint) => {
                this.lastValidation = { code, name: validationName(code), hint: hint || '', t: Number(ts) };
                this.emit('validation', this.lastValidation);
            });
            sdk.on('frameSentThrough', (sent) => { if (sent) this.counts.sent++; else this.counts.dropped++; });
            sdk.on('metrics', (buf) => this.onMetrics(buf));
            sdk.on('error', (code, message, retryable) => {
                this.emit('error', { code, message, retryable });
            });
            sdk.useMediaStream(stream);
            await sdk.start();
        } catch (e) {
            const err = e as { code?: number | string; message?: string };
            this.emit('error', { code: err.code ?? 'start', message: err.message ?? String(e), retryable: true });
            await this.stop();
            this.setPhase('error');
            throw e;
        }
    }

    private onMetrics(buf: Uint8Array) {
        let m;
        try { m = decodeMetrics(buf); } catch { return; }
        const face = m.face;
        if (!face) return;
        for (const b of face.blinking ?? []) {
            this.counts.blink++;
            this.emit('blink', tsToNumber(b.timestamp));
        }
        for (const l of face.landmarks ?? []) {
            const pts = (l.value ?? []) as Point[];
            if (pts.length < 400) continue;
            this.counts.landmarks++;
            const e = eyeOpenness(pts);
            this.emit('landmarks', tsToNumber(l.timestamp), e ? e.mean : null, fingerprint(pts));
        }
    }

    /** Stops the SDK and releases the camera. Safe to call repeatedly. */
    async stop(): Promise<void> {
        const sdk = this.sdk;
        this.sdk = null;
        if (sdk) {
            this.setPhase('stopping');
            try { await sdk.stop(); } catch { /* already stopped */ }
            try { sdk.destroy(); } catch { /* already destroyed */ }
        }
        this.gen++;
        if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
        if (this.frameVideo) { this.frameVideo.srcObject = null; this.frameVideo = null; }
        if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
        this.lastValidation = null;
        this.lastRates = null;
        this.setPhase('off');
    }
}

export const sensing = new SensingSession();
