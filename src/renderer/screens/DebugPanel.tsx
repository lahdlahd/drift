// Milestone 1 debug panel: shows exactly what Drift will act on in Milestone 2,
// plus a start/stop stress test for the camera and SDK lifecycle.
import { useEffect, useRef, useState } from 'react';
import { sensing } from '../sensing/session';
import { bridge } from '../bridge';
import { pipelineDelayMs, tracker, usePresence, useRates, useSessionPhase, useValidation } from '../usePresence';
import type { PresenceState } from '../sensing/presence';

const LABEL: Record<PresenceState, string> = {
    'no-signal': 'Waiting for your face',
    watching: 'Watching',
    'eyes-closed': 'Eyes closed',
    away: 'Away from the screen',
    'looking-away': 'Looking away (no pause)',
};

interface Transition { at: string; state: PresenceState; detail: string }
interface CycleResult { n: number; reachedRunning: boolean; landmarks: number; cameraReleased: boolean; error: string | null; ms: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runCycleTest(cycles: number, onResult: (r: CycleResult) => void): Promise<CycleResult[]> {
    const key = await bridge().key.load();
    const results: CycleResult[] = [];
    for (let n = 1; n <= cycles; n++) {
        const t0 = performance.now();
        let landmarks = 0;
        let error: string | null = null;
        const offL = sensing.on('landmarks', () => { landmarks++; });
        const offE = sensing.on('error', (e) => { error = `${e.code}: ${e.message}`; });
        let reachedRunning = false;
        try {
            await sensing.start(key ?? '');
            const deadline = performance.now() + 15000;
            while (performance.now() < deadline && sensing.phase !== 'running' && sensing.phase !== 'off') await sleep(100);
            reachedRunning = sensing.phase === 'running';
            if (reachedRunning) await sleep(3000);
        } catch (e) {
            error = error ?? String((e as Error).message ?? e);
        }
        const stream = sensing.mediaStream;
        await sensing.stop();
        const cameraReleased = !sensing.cameraOn && (!stream || stream.getTracks().every((t) => t.readyState === 'ended'));
        offL(); offE();
        const r = { n, reachedRunning, landmarks, cameraReleased, error, ms: Math.round(performance.now() - t0) };
        results.push(r);
        onResult(r);
        await sleep(800);
    }
    return results;
}

interface Props { onRecalibrate: () => void; onRemoveKey: () => void }

export function DebugPanel({ onRecalibrate, onRemoveKey }: Props) {
    const snap = usePresence();
    const phase = useSessionPhase();
    const validation = useValidation();
    const rates = useRates();
    const [log, setLog] = useState<Transition[]>([]);
    const [cycles, setCycles] = useState<CycleResult[] | null>(null);
    const [cycling, setCycling] = useState(false);
    const prev = useRef<PresenceState | null>(null);
    const cyclingRef = useRef(false);

    useEffect(() => {
        if (prev.current === snap.state) return;
        // The start/stop test restarts the camera 10 times: don't log those as state changes.
        if (cyclingRef.current) { prev.current = snap.state; return; }
        prev.current = snap.state;
        const detail = snap.state === 'eyes-closed' ? `after ${snap.eyesClosedForS.toFixed(1)} s` : snap.state === 'away' ? `still for ${snap.stillForS.toFixed(1)} s` : '';
        setLog((l) => [{ at: new Date().toLocaleTimeString(), state: snap.state, detail }, ...l].slice(0, 30));
    }, [snap.state, snap.eyesClosedForS, snap.stillForS]);

    const alert = snap.state === 'eyes-closed' || snap.state === 'away';
    const earMax = (tracker.eyeBaseline ?? 0.25) * 1.6;
    const pct = (v: number | null) => `${Math.max(0, Math.min(100, ((v ?? 0) / earMax) * 100))}%`;

    async function startCycles() {
        setCycling(true);
        cyclingRef.current = true;
        setCycles([]);
        await runCycleTest(10, (r) => setCycles((c) => [...(c ?? []), r]));
        cyclingRef.current = false;
        setCycling(false);
    }

    const passed = cycles?.filter((c) => c.reachedRunning && c.cameraReleased && c.landmarks > 0).length ?? 0;

    return (
        <div className="wide">
            <h1>Live signals</h1>
            <p className="muted">What Drift sees right now. Useful for checking your setup.</p>
            <div className="two">
                <div className="card">
                    <div className={`state ${alert ? 'alert' : ''}`} data-testid="presence-state" aria-live="polite">{LABEL[snap.state]}</div>
                    <p className="muted small">The lecture pauses on “Eyes closed” or “Away from the screen”, never on “Looking away”.</p>
                    <dl className="kv">
                        <dt>Eyes closed for</dt><dd>{snap.eyesClosedForS.toFixed(1)} s (pauses at {tracker.config.eyesClosedS} s)</dd>
                        <dt>Face still for</dt><dd>{snap.stillForS.toFixed(1)} s (away at {tracker.config.awayS} s)</dd>
                        <dt>Eye openness</dt>
                        <dd>
                            {snap.ear?.toFixed(3) ?? '—'}{snap.closedBelow != null && ` · closed below ${snap.closedBelow.toFixed(3)}`}
                            <div className="meter" aria-hidden>
                                <div className="fill" style={{ width: pct(snap.ear) }} />
                                {snap.closedBelow != null && <div className="line" style={{ left: pct(snap.closedBelow) }} />}
                            </div>
                        </dd>
                        <dt>Baseline (your open eyes)</dt><dd>{tracker.eyeBaseline?.toFixed(3) ?? 'not measured'}</dd>
                    </dl>
                </div>
                <div className="card">
                    <h2>Session</h2>
                    <dl className="kv">
                        <dt>SDK</dt><dd>{phase}</dd>
                        <dt>Validation</dt><dd>{validation ? `${validation.name}${validation.hint ? ` — ${validation.hint}` : ''}` : '—'}</dd>
                        <dt>Camera frames / s</dt><dd>{rates?.camera ?? '—'}</dd>
                        <dt>Frames to SDK / s</dt><dd>{rates ? `${rates.sent} sent, ${rates.dropped} dropped` : '—'}</dd>
                        <dt>Face frames / s</dt><dd>{rates?.landmarks ?? '—'}</dd>
                        <dt>Processing delay</dt><dd>{pipelineDelayMs() != null ? `${pipelineDelayMs()!.toFixed(0)} ms` : '—'}</dd>
                    </dl>
                    <div className="row">
                        <button className="btn" onClick={() => void sensing.stop()} disabled={phase === 'off'}>Stop camera</button>
                        <button className="btn" onClick={onRecalibrate}>{phase === 'off' ? 'Turn camera back on' : 'Re-run camera check'}</button>
                        <button className="btn danger" onClick={onRemoveKey}>Remove API key</button>
                    </div>
                </div>
            </div>

            <div className="two">
                <div className="card">
                    <h2>State changes</h2>
                    <table>
                        <thead><tr><th>Time</th><th>State</th><th>Detail</th></tr></thead>
                        <tbody>{log.map((t, i) => <tr key={i}><td>{t.at}</td><td>{LABEL[t.state]}</td><td>{t.detail}</td></tr>)}</tbody>
                    </table>
                </div>
                <div className="card">
                    <h2>Start/stop test</h2>
                    <p className="muted small">Starts and stops the camera and SDK 10 times (about 1 minute) and checks the camera is released each time.</p>
                    <button className="btn" data-testid="cycle-test" disabled={cycling} onClick={() => void startCycles()}>{cycling ? 'Running…' : 'Run 10 start/stop cycles'}</button>
                    {cycles && (
                        <>
                            <p style={{ marginTop: 12 }}><strong>{passed}/{cycles.length}</strong> passed</p>
                            <table>
                                <thead><tr><th>#</th><th>Running</th><th>Face frames</th><th>Camera released</th><th>Error</th></tr></thead>
                                <tbody>{cycles.map((c) => (
                                    <tr key={c.n}><td>{c.n}</td><td>{c.reachedRunning ? 'yes' : 'no'}</td><td>{c.landmarks}</td><td>{c.cameraReleased ? 'yes' : 'NO'}</td><td>{c.error ?? ''}</td></tr>
                                ))}</tbody>
                            </table>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
