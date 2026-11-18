// Drift engine: decides when to pause the lecture and where to rewind to.
// Pure and tick-driven (times in tracker µs, video times in seconds), so it is
// unit-tested by replaying the real Milestone 0 run against a simulated video.
//
// Rules:
//  - Pauses only while the video is playing (never when the user paused it).
//  - Pauses on 'eyes-closed' or 'away' from the presence tracker; never on
//    'looking-away' or 'no-signal' (looking down at notes must not pause).
//  - The drift is marked at its onset (when the eyes closed / the face left),
//    mapped back to the video time at that moment.
//  - "Back" = 'watching' continuously for returnS.
//  - Rewind target = onset − rewindSeconds (never before 0).
//  - One drift at a time: nothing new is raised until the user answers the card.

import type { PresenceSnapshot } from '../sensing/presence';

export type DriftReason = 'eyes-closed' | 'away';
export type DriftAction = 'rewind' | 'continue' | 'dismiss';

export interface Drift {
    id: number;
    reason: DriftReason;
    /** Video time (s) when the drift started. */
    onsetVideo: number;
    /** Video time (s) when Drift paused the video. */
    pausedAtVideo: number;
    /** Tracker time (µs) when the drift started / was detected / the user came back. */
    onsetT: number;
    pausedT: number;
    returnedT: number | null;
    action: DriftAction | null;
    rewindTo: number;
}

export type EngineEvent =
    | { type: 'pause'; drift: Drift }
    | { type: 'returned'; drift: Drift };

export interface PlayerState { playing: boolean; time: number }

export interface EngineOptions { rewindSeconds: number; returnS: number }

const US = 1e6;

export class DriftEngine {
    private opts: EngineOptions;
    private history: { t: number; video: number }[] = [];
    private nextId = 1;
    private watchingSince: number | null = null;
    current: Drift | null = null;
    drifts: Drift[] = [];

    constructor(opts: Partial<EngineOptions> = {}) {
        this.opts = { rewindSeconds: 30, returnS: 1.0, ...opts };
    }

    configure(opts: Partial<EngineOptions>) { this.opts = { ...this.opts, ...opts }; }

    /** The card is up until the user answers it. */
    get awaitingAnswer(): boolean { return this.current !== null; }

    reset() {
        this.history = [];
        this.current = null;
        this.drifts = [];
        this.watchingSince = null;
        this.nextId = 1;
    }

    /** Video time at tracker time t, from what was recorded while playing. */
    videoTimeAt(t: number, fallback: number): number {
        const h = this.history;
        if (h.length === 0) return fallback;
        if (t <= h[0]!.t) return h[0]!.video;
        for (let i = h.length - 1; i >= 0; i--) {
            const a = h[i]!;
            if (a.t <= t) {
                const b = h[i + 1];
                if (!b) return a.video + (t - a.t) / US; // extrapolate at 1× (clamped below)
                const f = (t - a.t) / (b.t - a.t);
                return a.video + f * (b.video - a.video);
            }
        }
        return fallback;
    }

    tick(now: number, snap: PresenceSnapshot, player: PlayerState): EngineEvent[] {
        const events: EngineEvent[] = [];

        if (player.playing) {
            this.history.push({ t: now, video: player.time });
            // Keep about 2 minutes, plenty for any onset.
            while (this.history.length > 1200) this.history.shift();
        }

        // Waiting for the user to come back / answer the card.
        if (this.current) {
            const d = this.current;
            if (d.returnedT === null) {
                if (snap.state === 'watching') {
                    if (this.watchingSince === null) this.watchingSince = now;
                    if ((now - this.watchingSince) / US >= this.opts.returnS) {
                        d.returnedT = now;
                        events.push({ type: 'returned', drift: d });
                    }
                } else {
                    this.watchingSince = null;
                }
            }
            return events;
        }

        if (!player.playing) return events;
        if (snap.state !== 'eyes-closed' && snap.state !== 'away') return events;

        const onsetT = snap.since ?? now;
        const onsetVideo = Math.min(player.time, Math.max(0, this.videoTimeAt(onsetT, player.time)));
        const drift: Drift = {
            id: this.nextId++,
            reason: snap.state,
            onsetVideo,
            pausedAtVideo: player.time,
            onsetT,
            pausedT: now,
            returnedT: null,
            action: null,
            rewindTo: Math.max(0, onsetVideo - this.opts.rewindSeconds),
        };
        this.current = drift;
        this.drifts.push(drift);
        this.watchingSince = null;
        events.push({ type: 'pause', drift });
        return events;
    }

    /** The user's answer to the card. Returns where to seek (or null to stay). */
    answer(action: DriftAction): number | null {
        const d = this.current;
        if (!d) return null;
        d.action = action;
        this.current = null;
        this.watchingSince = null;
        // Old history no longer maps to where the video will be.
        this.history = [];
        return action === 'rewind' ? d.rewindTo : null;
    }
}

export function formatTime(s: number): string {
    if (!Number.isFinite(s)) return '--:--';
    const t = Math.max(0, Math.floor(s));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
