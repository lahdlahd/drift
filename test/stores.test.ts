import { describe, it, expect } from 'vitest';
import { KeyStore, KeyStoreError, validateKey, type Encryptor, type FileOps } from '../src/main/keyStore';
import { SettingsStore, sanitizeSettings } from '../src/main/settingsStore';
import { DEFAULT_SETTINGS } from '../src/shared/ipc';
import { eyeOpenness } from '../src/renderer/sensing/ear';

function memFiles(): FileOps & { data: Map<string, Buffer> } {
    const data = new Map<string, Buffer>();
    return {
        data,
        exists: (p) => data.has(p),
        read: (p) => { const d = data.get(p); if (!d) throw new Error('ENOENT'); return d; },
        write: (p, d) => { data.set(p, Buffer.from(d)); },
        remove: (p) => { data.delete(p); },
    };
}

// Reversible fake "encryption" that is visibly not plain text.
const fakeCrypto = (available = true): Encryptor => ({
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64').split('').reverse().join('')}`),
    decryptString: (b) => {
        const s = b.toString();
        if (!s.startsWith('ENC:')) throw new Error('bad');
        return Buffer.from(s.slice(4).split('').reverse().join(''), 'base64').toString();
    },
});

describe('KeyStore', () => {
    const KEY = 'test-key-not-real-0000';

    it('saves encrypted and loads back the same key', () => {
        const files = memFiles();
        const ks = new KeyStore('/k.bin', fakeCrypto(), files);
        expect(ks.status()).toEqual({ stored: false, encryptionAvailable: true });
        expect(ks.save(`  ${KEY}\n`).stored).toBe(true);
        expect(files.data.get('/k.bin')!.toString()).not.toContain(KEY);
        expect(ks.load()).toBe(KEY);
    });

    it('refuses to store anything when the OS cannot encrypt', () => {
        const files = memFiles();
        const ks = new KeyStore('/k.bin', fakeCrypto(false), files);
        expect(() => ks.save(KEY)).toThrow(KeyStoreError);
        expect(files.data.size).toBe(0);
    });

    it('treats an undecryptable file as no key and removes on request', () => {
        const files = memFiles();
        files.write('/k.bin', Buffer.from('garbage'));
        const ks = new KeyStore('/k.bin', fakeCrypto(), files);
        expect(ks.load()).toBeNull();
        expect(ks.remove().stored).toBe(false);
    });

    it('rejects values that are not plausible keys', () => {
        expect(() => validateKey(123)).toThrow();
        expect(() => validateKey('short')).toThrow();
        expect(() => validateKey('has space in it')).toThrow();
        expect(validateKey(KEY)).toBe(KEY);
    });
});

describe('SettingsStore', () => {
    it('starts from defaults and keeps only valid fields', () => {
        const files = memFiles();
        const st = new SettingsStore('/s.json', files);
        expect(st.get()).toEqual(DEFAULT_SETTINGS);
        const next = st.save({ consentAccepted: true, eyeBaseline: 0.21, sensitivity: 'strict', rewindSeconds: 999, evil: 'x' });
        expect(next).toEqual({ ...DEFAULT_SETTINGS, consentAccepted: true, eyeBaseline: 0.21, sensitivity: 'strict' });
        expect(new SettingsStore('/s.json', files).get()).toEqual(next);
    });

    it('survives a corrupt file', () => {
        const files = memFiles();
        files.write('/s.json', Buffer.from('{not json'));
        expect(new SettingsStore('/s.json', files).get()).toEqual(DEFAULT_SETTINGS);
    });

    it('rejects out-of-range baselines', () => {
        expect(sanitizeSettings({ eyeBaseline: 5 }).eyeBaseline).toBeNull();
        expect(sanitizeSettings({ eyeBaseline: 0.21 }).eyeBaseline).toBe(0.21);
    });
});

describe('eyeOpenness', () => {
    it('reads the MediaPipe eye indices and needs a full mesh', () => {
        const pts = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
        const set = (idx: number[], open: number) => {
            const [p1, p2, p3, p4, p5, p6] = idx as [number, number, number, number, number, number];
            pts[p1] = { x: 0, y: 0 }; pts[p4] = { x: 1, y: 0 };
            pts[p2] = { x: 0.3, y: -open }; pts[p6] = { x: 0.3, y: open };
            pts[p3] = { x: 0.7, y: -open }; pts[p5] = { x: 0.7, y: open };
        };
        set([33, 160, 158, 133, 153, 144], 0.15);
        set([362, 385, 387, 263, 373, 380], 0.15);
        expect(eyeOpenness(pts)!.mean).toBeCloseTo(0.3, 9);
        expect(eyeOpenness(pts.slice(0, 100))).toBeNull();
    });
});
