// React hooks over the sensing session and the presence tracker.
import { useEffect, useRef, useState } from 'react';
import { sensing, type Rates, type SessionPhase, type ValidationInfo } from './sensing/session';
import { PresenceTracker, SENSITIVITY, type PresenceSnapshot } from './sensing/presence';
import type { SensitivityPreset } from '../shared/ipc';

export const tracker = new PresenceTracker();

// SDK timestamps are frame capture times; results arrive a little later. Track
// that pipeline delay so "now" for the tracker is on the same clock as the data.
let pipelineDelayUs: number | null = null;
export const trackerNow = () => Date.now() * 1000 - (pipelineDelayUs ?? 0);
export const pipelineDelayMs = () => (pipelineDelayUs == null ? null : pipelineDelayUs / 1000);

// Feed the tracker from the session once, for the app's lifetime.
sensing.on('landmarks', (t, ear, fp) => {
    const d = Date.now() * 1000 - t;
    if (d > -1e6 && d < 10e6) pipelineDelayUs = pipelineDelayUs == null ? d : pipelineDelayUs * 0.95 + d * 0.05;
    tracker.feedLandmarks(t, ear, fp);
});
sensing.on('blink', (t) => tracker.feedBlinkSample(t));
sensing.on('phase', (p) => { if (p === 'off' || p === 'starting') { tracker.reset(); pipelineDelayUs = null; } });

export function applySensitivity(preset: SensitivityPreset) {
    tracker.configure(SENSITIVITY[preset]);
}

export function useSessionPhase(): SessionPhase {
    const [phase, setPhase] = useState<SessionPhase>(sensing.phase);
    useEffect(() => sensing.on('phase', setPhase), []);
    return phase;
}

export function useCameraOn(): boolean {
    const [on, setOn] = useState(sensing.cameraOn);
    useEffect(() => {
        const id = setInterval(() => setOn(sensing.cameraOn), 250);
        return () => clearInterval(id);
    }, []);
    return on;
}

export function useValidation(): ValidationInfo | null {
    const [v, setV] = useState<ValidationInfo | null>(sensing.lastValidation);
    useEffect(() => {
        // Update only when the code changes, as Presage recommends (avoids flicker).
        return sensing.on('validation', (next) => setV((prev) => (prev && prev.code === next.code ? prev : next)));
    }, []);
    useEffect(() => sensing.on('phase', (p) => { if (p === 'off') setV(null); }), []);
    return v;
}

export function useRates(): Rates | null {
    const [r, setR] = useState<Rates | null>(sensing.lastRates);
    useEffect(() => sensing.on('rates', setR), []);
    useEffect(() => sensing.on('phase', (p) => { if (p === 'off') setR(null); }), []);
    return r;
}

/** Presence snapshot refreshed ~10× per second (timestamps in epoch µs, like the SDK's). */
export function usePresence(): PresenceSnapshot {
    const [snap, setSnap] = useState<PresenceSnapshot>(() => tracker.snapshot(trackerNow()));
    const raf = useRef<ReturnType<typeof setInterval> | null>(null);
    useEffect(() => {
        raf.current = setInterval(() => setSnap(tracker.snapshot(trackerNow())), 100);
        return () => { if (raf.current) clearInterval(raf.current); };
    }, []);
    return snap;
}
