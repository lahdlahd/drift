import { useCallback, useEffect, useState } from 'react';
import { bridge } from './bridge';
import { sensing } from './sensing/session';
import { applySensitivity, tracker, useCameraOn, usePresence } from './usePresence';
import { Welcome } from './screens/Welcome';
import { KeySetup } from './screens/KeySetup';
import { CameraCheck } from './screens/CameraCheck';
import { DebugPanel } from './screens/DebugPanel';
import { Player, engine, type Lecture } from './screens/Player';
import { Summary } from './screens/Summary';
import type { KeyStatus, Settings } from '../shared/ipc';

type Screen = 'loading' | 'welcome' | 'key' | 'check' | 'player' | 'summary' | 'signals';

export function App() {
    const [screen, setScreen] = useState<Screen>('loading');
    const [settings, setSettings] = useState<Settings | null>(null);
    const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
    const [declined, setDeclined] = useState(false);
    const [fatal, setFatal] = useState<string | null>(null);
    const [lecture, setLecture] = useState<Lecture | null>(null);
    const [resumeAt, setResumeAt] = useState<number | null>(null);
    const clearResume = useCallback(() => setResumeAt(null), []);
    const cameraOn = useCameraOn();
    const presence = usePresence();

    const route = useCallback((s: Settings, k: KeyStatus) => {
        if (!s.consentAccepted) setScreen('welcome');
        else if (!k.stored) setScreen('key');
        else setScreen('check');
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const [s, k] = await Promise.all([bridge().settings.get(), bridge().key.status()]);
                setSettings(s);
                setKeyStatus(k);
                applySensitivity(s.sensitivity);
                if (s.eyeBaseline) tracker.setBaseline(s.eyeBaseline);
                route(s, k);
            } catch (e) {
                setFatal(String((e as Error).message ?? e));
            }
        })();
    }, [route]);

    // Self-test only (#selftest): let the smoke test move between screens.
    useEffect(() => {
        if (location.hash === '#selftest') (window as unknown as { __driftGoto: (s: Screen) => void }).__driftGoto = setScreen;
    }, []);

    // Esc always turns the camera off.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') void sensing.stop(); };
        window.addEventListener('keydown', onKey);
        window.addEventListener('beforeunload', () => { void sensing.stop(); });
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    async function acceptConsent() {
        const s = await bridge().settings.save({ consentAccepted: true });
        setSettings(s);
        route(s, keyStatus ?? { stored: false, encryptionAvailable: true });
    }

    async function keySaved() {
        const k = await bridge().key.status();
        setKeyStatus(k);
        setScreen('check');
    }

    async function removeKey() {
        await sensing.stop();
        const k = await bridge().key.remove();
        setKeyStatus(k);
        setScreen('key');
    }

    const pillText = !cameraOn ? 'Camera off'
        : presence.state === 'eyes-closed' ? 'Camera on · Eyes closed'
        : presence.state === 'away' ? 'Camera on · Away'
        : presence.state === 'looking-away' ? 'Camera on · Looking away'
        : presence.state === 'watching' ? 'Camera on · Watching'
        : 'Camera on';

    return (
        <div className="app">
            <header className="topbar">
                <div className="topbar-left">
                    <div className="wordmark">Drift<span>.</span></div>
                    {(screen === 'player' || screen === 'summary' || screen === 'signals') && (
                        <nav className="nav" aria-label="Main">
                            <button className={`nav-btn ${screen === 'player' ? 'active' : ''}`} onClick={() => setScreen('player')}>Lecture</button>
                            <button className={`nav-btn ${screen === 'summary' ? 'active' : ''}`} onClick={() => setScreen('summary')}>Summary</button>
                            <button className={`nav-btn ${screen === 'signals' ? 'active' : ''}`} onClick={() => setScreen('signals')}>Live signals</button>
                        </nav>
                    )}
                </div>
                <div className="topbar-right">
                    <span className={`pill ${cameraOn ? 'on' : ''}`} data-testid="camera-pill" role="status"><span className="dot" />{pillText}</span>
                    {cameraOn && <button className="btn" onClick={() => void sensing.stop()} title="Esc">Stop camera</button>}
                </div>
            </header>
            <main className="page">
                {fatal && <p className="notice error">Drift could not start: {fatal}</p>}
                {screen === 'welcome' && <Welcome onAccept={() => void acceptConsent()} declined={declined} onDecline={() => setDeclined(true)} />}
                {screen === 'key' && <KeySetup status={keyStatus} onSaved={() => void keySaved()} />}
                {screen === 'check' && <CameraCheck onReady={() => setScreen('player')} onChangeKey={() => setScreen('key')} />}
                {screen === 'player' && (
                    <Player
                        lecture={lecture}
                        onOpen={setLecture}
                        onEnd={() => setScreen('summary')}
                        onNeedCamera={() => setScreen('check')}
                        resumeAt={resumeAt}
                        onResumed={clearResume}
                    />
                )}
                {screen === 'summary' && (
                    <Summary
                        lectureName={lecture?.name ?? null}
                        drifts={engine.drifts}
                        onWatchFrom={(t) => { setResumeAt(t); setScreen('player'); }}
                        onNewLecture={() => { if (lecture) URL.revokeObjectURL(lecture.url); engine.reset(); setLecture(null); setScreen('player'); }}
                        onBack={() => setScreen('player')}
                    />
                )}
                {screen === 'signals' && <DebugPanel onRecalibrate={() => setScreen('check')} onRemoveKey={() => void removeKey()} />}
                {settings && screen === 'loading' && null}
            </main>
        </div>
    );
}
