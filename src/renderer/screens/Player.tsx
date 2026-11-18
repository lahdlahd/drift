import { useCallback, useEffect, useRef, useState } from 'react';
import { DriftEngine, formatTime, type Drift } from '../drift/engine';
import { sensing } from '../sensing/session';
import { tracker, trackerNow, useSessionPhase, useValidation, useRates } from '../usePresence';
import { bridge } from '../bridge';
import { SENSITIVITY } from '../sensing/presence';
import type { SensitivityPreset } from '../../shared/ipc';

export interface Lecture { url: string; name: string }

// The headless smoke test (#selftest only) has no Presage connection; it drives the
// tracker with synthetic face data and marks the session as live with this flag.
const selfTestSession = () => location.hash === '#selftest' && !!(window as unknown as { __driftFakeSession?: boolean }).__driftFakeSession;

// One engine for the app's lifetime, so the summary can read it.
export const engine = new DriftEngine();

const POOR = new Set([5, 6, 11]); // TooDark, TooBright, FrameRateTooLow
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const REWINDS = [10, 20, 30, 45, 60];

const REASON_TITLE: Record<Drift['reason'], string> = {
    'eyes-closed': 'Paused: your eyes were closed',
    away: 'Paused: you stepped away',
};

interface Props {
    lecture: Lecture | null;
    onOpen: (l: Lecture) => void;
    onEnd: () => void;
    onNeedCamera: () => void;
    resumeAt: number | null;
    onResumed: () => void;
}

export function Player({ lecture, onOpen, onEnd, onNeedCamera, resumeAt, onResumed }: Props) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [rate, setRate] = useState(1);
    const [card, setCard] = useState<Drift | null>(engine.current);
    const [, force] = useState(0);
    const [announce, setAnnounce] = useState('');
    const [dragOver, setDragOver] = useState(false);
    const [fileError, setFileError] = useState<string | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [sensitivity, setSensitivity] = useState<SensitivityPreset>('standard');
    const [rewindSeconds, setRewindSeconds] = useState(30);
    const phase = useSessionPhase();
    const validation = useValidation();
    const rates = useRates();
    const watching = phase === 'running' || selfTestSession();

    useEffect(() => {
        void bridge().settings.get().then((s) => {
            setSensitivity(s.sensitivity);
            setRewindSeconds(s.rewindSeconds);
            engine.configure({ rewindSeconds: s.rewindSeconds });
        });
    }, []);

    // Jump to a position requested from the summary.
    useEffect(() => {
        const v = videoRef.current;
        if (v && resumeAt != null && lecture) {
            const go = () => { v.currentTime = resumeAt; void v.play(); onResumed(); };
            if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true });
        }
    }, [resumeAt, lecture, onResumed]);

    // Engine loop: 10 times a second.
    useEffect(() => {
        const id = setInterval(() => {
            const v = videoRef.current;
            if (!v || !lecture) return;
            const isPlaying = !v.paused && !v.ended;
            const sessionOk = sensing.phase === 'running' || selfTestSession();
            const now = trackerNow();
            const snap = tracker.snapshot(now);
            const events = engine.tick(now, sessionOk ? snap : { ...snap, state: 'no-signal' }, { playing: isPlaying && sessionOk, time: v.currentTime });
            for (const ev of events) {
                if (ev.type === 'pause') {
                    v.pause();
                    setCard(ev.drift);
                    setAnnounce(`${REASON_TITLE[ev.drift.reason]} at ${formatTime(ev.drift.onsetVideo)}.`);
                } else {
                    force((n) => n + 1);
                    setAnnounce(`Welcome back. Rewind to ${formatTime(ev.drift.rewindTo)}?`);
                }
            }
        }, 100);
        return () => clearInterval(id);
    }, [lecture]);

    const answer = useCallback((action: 'rewind' | 'continue' | 'dismiss') => {
        const v = videoRef.current;
        const seek = engine.answer(action);
        setCard(null);
        if (!v) return;
        if (seek != null) v.currentTime = seek;
        if (action !== 'dismiss') void v.play();
    }, []);

    const togglePlay = useCallback(() => {
        const v = videoRef.current;
        if (!v || !lecture) return;
        if (engine.awaitingAnswer) { answer('continue'); return; }
        if (v.paused) void v.play(); else v.pause();
    }, [answer, lecture]);

    // Keyboard: Space play/pause (or Continue), R rewind, ←/→ 5 s.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            const v = videoRef.current;
            if (e.code === 'Space') {
                if (tag === 'BUTTON') return; // the focused button handles Space itself
                e.preventDefault(); togglePlay();
            }
            else if ((e.key === 'r' || e.key === 'R') && engine.awaitingAnswer) answer('rewind');
            else if (e.key === 'ArrowLeft' && v) v.currentTime = Math.max(0, v.currentTime - 5);
            else if (e.key === 'ArrowRight' && v) v.currentTime = Math.min(v.duration || 0, v.currentTime + 5);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [togglePlay, answer]);

    function openFile(f: File | undefined) {
        if (!f) return;
        setFileError(null);
        const probe = document.createElement('video');
        if (!f.type.startsWith('video/') || probe.canPlayType(f.type) === '') {
            setFileError('Drift can play MP4 (H.264) and WebM videos. Convert this file, or choose another.');
            return;
        }
        if (lecture) URL.revokeObjectURL(lecture.url);
        engine.reset();
        setCard(null);
        onOpen({ url: URL.createObjectURL(f), name: f.name });
    }

    async function saveSettings(patch: { sensitivity?: SensitivityPreset; rewindSeconds?: number }) {
        const s = await bridge().settings.save(patch);
        setSensitivity(s.sensitivity);
        setRewindSeconds(s.rewindSeconds);
        tracker.configure(SENSITIVITY[s.sensitivity]);
        engine.configure({ rewindSeconds: s.rewindSeconds });
    }

    if (!lecture) {
        return (
            <div className="wide">
                {!watching && <CameraBanner onNeedCamera={onNeedCamera} />}
                <div
                    className={`dropzone ${dragOver ? 'over' : ''}`}
                    data-testid="dropzone"
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => { e.preventDefault(); setDragOver(false); openFile(e.dataTransfer.files[0]); }}
                >
                    <h1>Drop a lecture video here</h1>
                    <p className="muted">MP4 or WebM from your computer. It stays on your computer.</p>
                    <button className="btn primary" onClick={() => fileRef.current?.click()}>Choose a file</button>
                    <input ref={fileRef} type="file" accept="video/mp4,video/webm,video/*" hidden data-testid="file-input" onChange={(e) => openFile(e.target.files?.[0])} />
                    {fileError && <p className="notice error" role="alert">{fileError}</p>}
                </div>
            </div>
        );
    }

    const poor = watching && ((validation && POOR.has(validation.code)) || (rates != null && rates.camera < 20));
    const pct = (t: number) => (duration > 0 ? `${Math.min(100, (t / duration) * 100)}%` : '0%');

    return (
        <div className="player">
            {!watching && <CameraBanner onNeedCamera={onNeedCamera} />}
            {poor && <div className="banner warn" role="status">Signal poor: {validation?.hint || 'add light in front of your face'}. Drift may miss drifts until it improves.</div>}
            <div className="stage">
                <video
                    ref={videoRef}
                    src={lecture.url}
                    data-testid="video"
                    className={card ? 'dimmed' : ''}
                    onTimeUpdate={(e) => { setTime(e.currentTarget.currentTime); setDuration(knownDuration(e.currentTarget)); }}
                    onLoadedMetadata={(e) => setDuration(knownDuration(e.currentTarget))}
                    onDurationChange={(e) => setDuration(knownDuration(e.currentTarget))}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => { setPlaying(false); if (!engine.awaitingAnswer) onEnd(); }}
                    onClick={togglePlay}
                />
                {card && (
                    <div className="drift-card" role="dialog" aria-labelledby="drift-title" data-testid="drift-card">
                        <h2 id="drift-title">{REASON_TITLE[card.reason]}</h2>
                        <p className="muted">You drifted at {formatTime(card.onsetVideo)}.</p>
                        {card.reason === 'away' && card.returnedT === null && <p className="waiting">Waiting for you…</p>}
                        <div className="row center">
                            <button className="btn primary" data-testid="card-rewind" autoFocus onClick={() => answer('rewind')}>Rewind to {formatTime(card.rewindTo)}</button>
                            <button className="btn" data-testid="card-continue" onClick={() => answer('continue')}>Continue from {formatTime(card.pausedAtVideo)}</button>
                        </div>
                        <button className="link-btn small" data-testid="card-dismiss" onClick={() => answer('dismiss')}>Dismiss</button>
                        <p className="hint">R to rewind · Space to continue</p>
                    </div>
                )}
            </div>

            <div className="controls">
                <button className="btn" data-testid="play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>{playing ? 'Pause' : 'Play'}</button>
                <span className="time">{formatTime(time)} / {formatTime(duration)}</span>
                <div className="track" onClick={(e) => {
                    const v = videoRef.current; if (!v || !(duration > 0)) return;
                    const r = e.currentTarget.getBoundingClientRect();
                    v.currentTime = ((e.clientX - r.left) / r.width) * duration;
                }} role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)} tabIndex={0}>
                    <div className="played" style={{ width: pct(time) }} />
                    {engine.drifts.map((d) => (
                        <div key={d.id} className="marker" style={{ left: pct(d.onsetVideo) }} title={`Drifted at ${formatTime(d.onsetVideo)}`} />
                    ))}
                </div>
                <select aria-label="Playback speed" value={rate} onChange={(e) => { const r = Number(e.target.value); setRate(r); if (videoRef.current) videoRef.current.playbackRate = r; }}>
                    {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
                </select>
                <button className="btn" onClick={() => setSettingsOpen((o) => !o)} aria-expanded={settingsOpen}>Settings</button>
                <button className="btn" data-testid="end" onClick={() => { videoRef.current?.pause(); onEnd(); }}>End lecture</button>
            </div>
            <p className="small muted file-name">{lecture.name} · {engine.drifts.length} drift{engine.drifts.length === 1 ? '' : 's'} marked</p>

            {settingsOpen && (
                <div className="card settings" role="dialog" aria-label="Settings">
                    <label htmlFor="sens">Sensitivity</label>
                    <select id="sens" value={sensitivity} onChange={(e) => void saveSettings({ sensitivity: e.target.value as SensitivityPreset })}>
                        <option value="relaxed">Relaxed: eyes closed 5 s, away 6 s</option>
                        <option value="standard">Standard: eyes closed 3 s, away 4 s</option>
                        <option value="strict">Strict: eyes closed 2 s, away 3 s</option>
                    </select>
                    <label htmlFor="rew" style={{ marginTop: 12 }}>Rewind to before the drift by</label>
                    <select id="rew" value={rewindSeconds} onChange={(e) => void saveSettings({ rewindSeconds: Number(e.target.value) })}>
                        {REWINDS.map((r) => <option key={r} value={r}>{r} seconds</option>)}
                    </select>
                    <div className="row"><button className="btn" onClick={() => setSettingsOpen(false)}>Done</button></div>
                </div>
            )}
            <div className="sr-only" aria-live="assertive">{announce}</div>
        </div>
    );
}

/** Length of the video; some WebM files don't store it, so use the seekable range. */
const furthest = new WeakMap<HTMLVideoElement, number>();
function knownDuration(v: HTMLVideoElement): number {
    if (Number.isFinite(v.duration)) return v.duration;
    const end = v.seekable.length ? v.seekable.end(v.seekable.length - 1) : 0;
    const best = Math.max(furthest.get(v) ?? 0, Number.isFinite(end) ? end : 0, v.currentTime);
    furthest.set(v, best);
    return best;
}

function CameraBanner({ onNeedCamera }: { onNeedCamera: () => void }) {
    return (
        <div className="banner" role="status">
            Camera off: Drift is not watching for drifts.
            <button className="btn primary" onClick={onNeedCamera}>Turn on camera</button>
        </div>
    );
}
