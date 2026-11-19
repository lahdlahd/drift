import { useEffect, useState } from 'react';
import { bridge } from '../bridge';
import { LOOK_AWAY_OPTIONS, REWIND_OPTIONS, SENSITIVITY_LABEL, savePreferences } from '../preferences';
import type { KeyStatus, SensitivityPreset, Settings } from '../../shared/ipc';

interface Props {
    onCameraCheck: () => void;
    onLiveSignals: () => void;
    onReplaceKey: () => void;
    onRemoveKey: () => void;
    onWithdrawConsent: () => void;
}

export function SettingsScreen({ onCameraCheck, onLiveSignals, onReplaceKey, onRemoveKey, onWithdrawConsent }: Props) {
    const [s, setS] = useState<Settings | null>(null);
    const [key, setKey] = useState<KeyStatus | null>(null);
    const [confirm, setConfirm] = useState<'key' | 'consent' | null>(null);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        void Promise.all([bridge().settings.get(), bridge().key.status()]).then(([a, b]) => { setS(a); setKey(b); });
    }, []);

    async function save(patch: Partial<Settings>) {
        setS(await savePreferences(patch));
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
    }

    if (!s) return null;

    return (
        <div className="column settings-page">
            <h1>Settings</h1>
            <p className="muted" role="status" aria-live="polite">{saved ? 'Saved.' : 'Changes are saved as you make them.'}</p>

            <section className="card">
                <h2>When Drift pauses</h2>
                <label htmlFor="set-sens">Sensitivity</label>
                <select id="set-sens" value={s.sensitivity} onChange={(e) => void save({ sensitivity: e.target.value as SensitivityPreset })}>
                    {(Object.keys(SENSITIVITY_LABEL) as SensitivityPreset[]).map((k) => <option key={k} value={k}>{SENSITIVITY_LABEL[k]}</option>)}
                </select>
                <label htmlFor="set-look" className="spaced">Pause when Drift can't see your face</label>
                <select id="set-look" value={s.lookAwaySeconds} onChange={(e) => void save({ lookAwaySeconds: Number(e.target.value) })}>
                    {LOOK_AWAY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <p className="hint">Glances at your notes never pause the lecture. This catches long look-aways, like checking your phone.</p>
                <label htmlFor="set-rew" className="spaced">Rewind to before the drift by</label>
                <select id="set-rew" value={s.rewindSeconds} onChange={(e) => void save({ rewindSeconds: Number(e.target.value) })}>
                    {REWIND_OPTIONS.map((r) => <option key={r} value={r}>{r} seconds</option>)}
                </select>
            </section>

            <section className="card">
                <h2>Camera</h2>
                <p className="muted">Your normal eye openness: {s.eyeBaseline ? s.eyeBaseline.toFixed(3) : 'not measured yet'}. It is measured again at each camera check.</p>
                <div className="row">
                    <button className="btn" onClick={onCameraCheck}>Run the camera check</button>
                    <button className="btn" onClick={onLiveSignals}>See what Drift sees</button>
                </div>
            </section>

            <section className="card">
                <h2>Presage API key</h2>
                <p className="muted">{key?.stored ? 'Saved on this computer, encrypted by your operating system.' : 'No key saved.'}</p>
                <div className="row">
                    <button className="btn" onClick={onReplaceKey}>Replace key</button>
                    {key?.stored && confirm !== 'key' && <button className="btn danger" onClick={() => setConfirm('key')}>Remove key</button>}
                    {confirm === 'key' && (
                        <>
                            <span>Remove the key from this computer?</span>
                            <button className="btn danger" onClick={onRemoveKey}>Yes, remove</button>
                            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
                        </>
                    )}
                </div>
            </section>

            <section className="card">
                <h2>Privacy</h2>
                <ul className="facts">
                    <li>Drift never records, saves or uploads video or photos of you. Camera frames go only to the Presage SmartSpectra SDK running inside Drift.</li>
                    <li>Drift asks the SDK for face signals only, and turns Presage's optional usage telemetry off.</li>
                    <li>The SDK contacts Presage with your API key to check the key and your credits.</li>
                    <li>Your drift list for a lecture is kept in memory and is gone when you close Drift.</li>
                    <li>Saved on this computer: your encrypted key, and a small settings file with your consent, preferences and eye-openness measurement.</li>
                    <li>Drift is a study aid, not a health or safety tool. Do not use it while driving.</li>
                </ul>
                <div className="row">
                    {confirm !== 'consent' && <button className="btn" onClick={() => setConfirm('consent')}>Withdraw camera consent</button>}
                    {confirm === 'consent' && (
                        <>
                            <span>Stop the camera and go back to the start?</span>
                            <button className="btn danger" onClick={onWithdrawConsent}>Yes, withdraw</button>
                            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
                        </>
                    )}
                </div>
            </section>
        </div>
    );
}
