// Presence tracker: turns the raw face signals into what Drift cares about.
// Pure and time-driven (timestamps in microseconds), so it is unit-tested
// against the real Milestone 0 trace.
//
// Rules (from the M0 results in the plan):
//  - Eyes closed: eye openness below closeFactor × the user's own open-eye
//    baseline, continuously. Reopens above reopenFactor × baseline (hysteresis).
//  - Away from seat: face landmarks stop changing (SmartSpectra keeps sending the
//    last landmarks unchanged when the face is gone; validation still says OK).
//  - Looking away/down: the face stops being tracked, so landmark frames stop
//    arriving (or blink samples stop while landmarks still move). Status only:
//    looking down at notes must never pause the lecture.

import type { SensitivityPreset } from '../../shared/ipc';

export type PresenceState = 'no-signal' | 'watching' | 'eyes-closed' | 'away' | 'looking-away';

export interface PresenceConfig {
    closeFactor: number;
    reopenFactor: number;
    eyesClosedS: number;
    awayS: number;
    lookingAwayS: number;
    /** Relative landmark movement per frame below which the face counts as frozen. */
    stillMotion: number;
}

export const SENSITIVITY: Record<SensitivityPreset, Pick<PresenceConfig, 'eyesClosedS' | 'awayS'>> = {
    relaxed: { eyesClosedS: 5, awayS: 6 },
    standard: { eyesClosedS: 3, awayS: 4 },
    strict: { eyesClosedS: 2, awayS: 3 },
};

export const DEFAULT_CONFIG: PresenceConfig = {
    closeFactor: 0.6,
    reopenFactor: 0.7,
    ...SENSITIVITY.standard,
    lookingAwayS: 1.0,
    stillMotion: 1e-4,
};

export interface PresenceSnapshot {
    state: PresenceState;
    /** Seconds the eyes have been continuously closed (0 when open or unknown). */
    eyesClosedForS: number;
    /** Seconds since the landmarks last changed. */
    stillForS: number;
    /** Seconds since the last blink sample (blink samples stop when the eyes are not tracked). */
    blinkGapS: number;
    ear: number | null;
    /** Eye openness below which the eyes count as closed (null until calibrated). */
    closedBelow: number | null;
    /** Start of the current eyes-closed or away episode, in µs. */
    since: number | null;
    /** Latest relative landmark movement (diagnostics). */
    motion: number | null;
}

const US = 1e6;

export class PresenceTracker {
    private cfg: PresenceConfig;
    private baseline: number | null = null;
    private lastMotion: number | null = null;
    private lastEar: number | null = null;
    private lastLandmarkT: number | null = null;
    private lastChangeT: number | null = null;
    private lastBlinkT: number | null = null;
    private closedSince: number | null = null;
    private stateSince: number | null = null;
    private prevState: PresenceState = 'no-signal';

    constructor(cfg: Partial<PresenceConfig> = {}) {
        this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    }

    configure(cfg: Partial<PresenceConfig>) { this.cfg = { ...this.cfg, ...cfg }; }
    get config(): PresenceConfig { return this.cfg; }

    setBaseline(b: number | null) { this.baseline = b; this.closedSince = null; }
    get eyeBaseline(): number | null { return this.baseline; }

    reset() {
        this.lastMotion = null; this.lastEar = null; this.lastLandmarkT = null; this.lastChangeT = null;
        this.lastBlinkT = null; this.closedSince = null; this.stateSince = null; this.prevState = 'no-signal';
    }

    /** One landmark frame. `motion` = relative movement since the previous frame (see landmarkMotion). */
    feedLandmarks(t: number, ear: number | null, motion: number) {
        const changed = this.lastLandmarkT === null || !(motion <= this.cfg.stillMotion);
        this.lastMotion = motion;
        this.lastLandmarkT = t;
        if (changed) this.lastChangeT = t;
        if (ear == null) return;
        this.lastEar = ear;
        // Frozen landmarks carry a stale eye value: do not let it start or end a closure.
        if (!changed) return;
        if (this.baseline == null) { this.closedSince = null; return; }
        if (ear < this.cfg.closeFactor * this.baseline) {
            if (this.closedSince === null) this.closedSince = t;
        } else if (ear > this.cfg.reopenFactor * this.baseline) {
            this.closedSince = null;
        }
    }

    feedBlinkSample(t: number) { this.lastBlinkT = t; }

    snapshot(now: number): PresenceSnapshot {
        // "Still" only counts while landmark frames keep arriving unchanged.
        const stillForS = this.lastChangeT === null || this.lastLandmarkT === null ? 0 : (this.lastLandmarkT - this.lastChangeT) / US + Math.min((now - this.lastLandmarkT) / US, this.cfg.lookingAwayS);
        const blinkGapS = this.lastBlinkT === null ? 0 : (now - this.lastBlinkT) / US;
        const neverTracked = this.lastLandmarkT === null;
        const untrackedForS = neverTracked ? 0 : (now - this.lastLandmarkT!) / US;
        const eyesClosedForS = this.closedSince === null || stillForS >= this.cfg.awayS ? 0 : (now - this.closedSince) / US;

        let state: PresenceState;
        if (neverTracked) state = 'no-signal';
        else if (untrackedForS >= this.cfg.lookingAwayS) state = 'looking-away';
        else if (stillForS >= this.cfg.awayS) state = 'away';
        else if (eyesClosedForS >= this.cfg.eyesClosedS) state = 'eyes-closed';
        else if (blinkGapS >= this.cfg.lookingAwayS && stillForS < this.cfg.lookingAwayS) state = 'looking-away';
        else state = 'watching';

        if (state !== this.prevState) {
            this.prevState = state;
            if (state === 'eyes-closed') this.stateSince = this.closedSince;
            else if (state === 'away') this.stateSince = this.lastChangeT;
            else this.stateSince = now;
        }

        return {
            state,
            eyesClosedForS,
            stillForS,
            blinkGapS,
            ear: this.lastEar,
            closedBelow: this.baseline == null ? null : this.cfg.closeFactor * this.baseline,
            since: this.stateSince,
            motion: this.lastMotion,
        };
    }
}

/** Median of eye-openness samples collected while the user looks at the screen. */
export function computeBaseline(samples: number[], minSamples = 60): number | null {
    const valid = samples.filter((v) => Number.isFinite(v) && v > 0.05 && v < 1);
    if (valid.length < minSamples) return null;
    const s = [...valid].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? null;
}
