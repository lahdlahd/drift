import { useEffect, useRef, useState } from 'react';
import { sensing, type SessionError } from '../sensing/session';
import { SmartSpectraErrorCode as E, ValidationCode as V } from '@smartspectra/node-sdk/renderer';
import { computeBaseline } from '../sensing/presence';
import { bridge, cleanError } from '../bridge';
import { tracker, useRates, useSessionPhase, useValidation } from '../usePresence';

type Step = 'idle' | 'measuring' | 'starting' | 'checking' | 'calibrating' | 'ready';

interface Props { onReady: () => void; onChangeKey: () => void }

const CALIBRATION_MS = 5000;
const OK = V.kOk;
const TOO_DARK = V.kTooDark;
const TOO_BRIGHT = V.kTooBright;

export function describeSdkError(e: SessionError): string {
    switch (e.code) {
        case E.kAuthenticationFailed: return 'Presage did not accept the API key. Check it, or replace it.';
        case E.kCreditExhausted: return 'Your Presage trial credits have run out. Ask Presage on Discord for more.';
        case E.kNetworkError: return 'Drift could not reach Presage. Check your internet connection and try again.';
        case E.kServerError: return 'Presage\'s service had a problem. Wait a minute and try again.';
        case E.kMetricNotAuthorized: return 'Your Presage key is not enabled for face metrics.';
        case E.kSustainedLowFrameRate: return 'The camera frame rate dropped too low. Add light in front of your face and try again.';
        case E.kInputUnavailable: return 'The camera is unavailable. Close other apps that use it, then try again.';
        case 'camera-ended': return 'The camera was turned off or disconnected (for example in Windows camera privacy settings). Turn it back on, then restart the camera.';
        default: return `SmartSpectra stopped: ${e.message}`;
    }
}

function cameraErrorText(e: unknown): string {
    const name = (e as { name?: string }).name;
    if (name === 'NotAllowedError') return 'Camera permission was refused. Allow camera access for Drift in Windows Settings → Privacy & security → Camera.';
    if (name === 'NotReadableError') return 'The camera is busy. Close other apps that use it (Zoom, Teams, the Camera app), then try again.';
    if (name === 'NotFoundError') return 'No camera was found.';
    return cleanError(e);
}

export function CameraCheck({ onReady, onChangeKey }: Props) {
    const [step, setStep] = useState<Step>(sensing.phase === 'running' ? 'checking' : 'idle');
    const [fps, setFps] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [authError, setAuthError] = useState(false);
    const [calibProgress, setCalibProgress] = useState(0);
    const [baseline, setBaseline] = useState<number | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const phase = useSessionPhase();
    const validation = useValidation();
    const rates = useRates();

    // Show the live preview whenever the camera is on.
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = sensing.mediaStream;
        if (sensing.mediaStream) void v.play().catch(() => {});
    }, [step, phase]);

    useEffect(() => sensing.on('error', (e) => {
        setError(describeSdkError(e));
        setAuthError(e.code === 2);
    }), []);

    async function turnOn() {
        setError(null);
        setAuthError(false);
        setBaseline(null);
        setStep('measuring');
        try {
            const measured = await sensing.measureCameraFps(5000);
            setFps(measured);
            if (measured < 20) {
                setStep('idle');
                setError(`Your camera is giving ${measured.toFixed(0)} frames per second; Drift needs about 25. Turn on a light in front of your face (not behind you), plug in the charger, then try again.`);
                await sensing.stop();
                return;
            }
            setStep('starting');
            const key = await bridge().key.load();
            if (!key) { await sensing.stop(); onChangeKey(); return; }
            await sensing.start(key);
            setStep('checking');
        } catch (e) {
            if (sensing.phase !== 'error') setError(cameraErrorText(e));
            setStep('idle');
            await sensing.stop();
        }
    }

    async function turnOff() {
        await sensing.stop();
        setStep('idle');
    }

    // If the session ends (Stop, Esc, or an SDK error), go back to the start.
    useEffect(() => {
        if (phase === 'off' && (step === 'checking' || step === 'calibrating' || step === 'ready')) setStep('idle');
    }, [phase, step]);

    // Live checks.
    const running = phase === 'running';
    const faceTracked = running && (rates?.landmarks ?? 0) >= 15;
    const framingOk = running && validation?.code === OK;
    const lightOk = running && validation?.code !== TOO_DARK && validation?.code !== TOO_BRIGHT && (rates?.camera ?? fps ?? 0) >= 22;
    const allOk = faceTracked && framingOk && lightOk;

    // Calibration: collect eye openness for 5 s while everything is OK.
    useEffect(() => {
        if (step !== 'calibrating') return;
        const samples: number[] = [];
        const started = performance.now();
        const off = sensing.on('landmarks', (_t, ear) => { if (ear != null) samples.push(ear); });
        const id = setInterval(async () => {
            const p = Math.min(1, (performance.now() - started) / CALIBRATION_MS);
            setCalibProgress(p);
            if (p < 1) return;
            clearInterval(id);
            off();
            const b = computeBaseline(samples, 60);
            if (b == null) {
                setError('Drift could not see your eyes clearly enough. Face the screen in good light and try again.');
                setStep('checking');
                return;
            }
            tracker.setBaseline(b);
            await bridge().settings.save({ eyeBaseline: b });
            setBaseline(b);
            setStep('ready');
        }, 100);
        return () => { clearInterval(id); off(); };
    }, [step]);

    // Abort calibration if the face is lost.
    useEffect(() => {
        if (step === 'calibrating' && !allOk) { setStep('checking'); setCalibProgress(0); }
    }, [step, allOk]);

    const item = (state: 'ok' | 'bad' | 'wait', title: string, detail?: string) => (
        <li className={state}>
            <span className="mark" aria-hidden>{state === 'ok' ? '✓' : state === 'bad' ? '!' : '·'}</span>
            <span>{title}{detail && <div className="hint">{detail}</div>}</span>
        </li>
    );

    const speedState = fps == null ? 'wait' : fps >= 25 ? 'ok' : 'bad';

    return (
        <div className="wide">
            <h1>Camera check</h1>
            <p className="muted">Sit where you study, with light in front of your face. This takes about 20 seconds.</p>
            <p className="muted">Tinted or mirrored glasses hide your eyes: take them off or use clear lenses.</p>
            <div className="check-grid">
                <div>
                    <div className="preview">
                        <video ref={videoRef} muted playsInline aria-label="Camera preview" />
                        {sensing.mediaStream ? <div className="oval" aria-hidden /> : <div className="empty">Camera is off</div>}
                    </div>
                </div>
                <div>
                    <ul className="checklist" aria-live="polite">
                        {item(speedState, 'Camera speed', fps == null ? 'Measured when the camera turns on' : `${fps.toFixed(0)} frames per second${fps < 25 ? ' — add light in front of you' : ''}`)}
                        {item(!running ? 'wait' : faceTracked ? 'ok' : 'bad', 'Face found', running && !faceTracked ? 'Sit facing the screen' : undefined)}
                        {item(!running ? 'wait' : framingOk ? 'ok' : 'bad', 'Facing the camera, centred', running && !framingOk ? validation?.hint || 'Adjusting…' : undefined)}
                        {item(!running ? 'wait' : lightOk ? 'ok' : 'bad', 'Enough light', running && !lightOk ? 'Add light in front of your face' : undefined)}
                        {item(baseline ? 'ok' : step === 'calibrating' ? 'wait' : 'wait', 'Your normal eye openness', baseline ? `Measured (${baseline.toFixed(3)})` : 'Measured in 5 seconds once the checks above pass')}
                    </ul>

                    {step === 'measuring' && <p className="muted">Measuring camera speed…</p>}
                    {step === 'starting' && <p className="muted">Starting SmartSpectra…</p>}
                    {step === 'calibrating' && (
                        <div>
                            <p>Look at the screen with your eyes open, as if watching a lecture.</p>
                            <div className="progress"><div style={{ width: `${calibProgress * 100}%` }} /></div>
                        </div>
                    )}
                    {error && <p className="notice error" role="alert">{error}</p>}

                    <div className="row">
                        {step === 'idle' && <button className="btn primary" data-testid="camera-on" onClick={() => void turnOn()}>Turn on camera</button>}
                        {step === 'checking' && (
                            <button className="btn primary" data-testid="calibrate" disabled={!allOk} onClick={() => { setError(null); setCalibProgress(0); setStep('calibrating'); }}>
                                Measure my eyes (5 s)
                            </button>
                        )}
                        {step === 'ready' && <button className="btn primary" data-testid="continue" onClick={onReady}>Continue</button>}
                        {sensing.mediaStream && <button className="btn" data-testid="camera-off" onClick={() => void turnOff()}>Stop camera</button>}
                        {authError && <button className="btn" onClick={onChangeKey}>Replace API key</button>}
                    </div>
                </div>
            </div>
        </div>
    );
}
