import { useState } from 'react';
import { bridge, cleanError } from '../bridge';
import type { KeyStatus } from '../../shared/ipc';

interface Props { status: KeyStatus | null; onSaved: () => void }

export function KeySetup({ status, onSaved }: Props) {
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save() {
        setBusy(true);
        setError(null);
        try {
            await bridge().key.save(value);
            setValue('');
            onSaved();
        } catch (e) {
            setError(cleanError(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="column">
            <h1>Add your Presage API key</h1>
            <p className="muted">
                Drift uses your own Presage SmartSpectra key. It is stored encrypted on this computer (never in
                plain text, never inside the app) and you can remove it in Settings.
            </p>
            <div className="card">
                <label htmlFor="api-key">API key</label>
                <input
                    id="api-key"
                    data-testid="key-input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && value) void save(); }}
                    placeholder="Paste your key"
                />
                <p className="hint" style={{ marginTop: 8 }}>
                    Don't have one?{' '}
                    <button className="link-btn" onClick={() => void bridge().openPortal()}>Get a key from the Presage portal</button>
                </p>
                {status && !status.encryptionAvailable && (
                    <p className="notice warn">This computer cannot encrypt saved secrets, so Drift will not be able to store the key.</p>
                )}
                {error && <p className="notice error" role="alert">{error}</p>}
                <div className="row">
                    <button className="btn primary" data-testid="key-save" disabled={!value || busy} onClick={() => void save()}>
                        {busy ? 'Saving…' : 'Save key'}
                    </button>
                </div>
            </div>
        </div>
    );
}
