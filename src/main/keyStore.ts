// Stores the user's Presage API key encrypted with the operating system's
// protection (Electron safeStorage: DPAPI on Windows, Keychain on macOS).
// Nothing is written if encryption is unavailable: the key is never stored in plain text.
import type { KeyStatus } from '../shared/ipc';

export interface Encryptor {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Buffer;
    decryptString(cipher: Buffer): string;
}

export interface FileOps {
    exists(path: string): boolean;
    read(path: string): Buffer;
    write(path: string, data: Buffer): void;
    remove(path: string): void;
}

export class KeyStoreError extends Error {}

/** Presage keys are opaque strings; accept printable ASCII without spaces, 8–512 chars. */
export function validateKey(raw: unknown): string {
    if (typeof raw !== 'string') throw new KeyStoreError('The key must be text.');
    const key = raw.trim();
    if (key.length < 8 || key.length > 512) throw new KeyStoreError('That does not look like a Presage API key.');
    if (!/^[\x21-\x7e]+$/.test(key)) throw new KeyStoreError('The key contains spaces or unusual characters.');
    return key;
}

export class KeyStore {
    constructor(
        private readonly path: string,
        private readonly crypto: Encryptor,
        private readonly files: FileOps,
    ) {}

    status(): KeyStatus {
        return { stored: this.files.exists(this.path), encryptionAvailable: this.crypto.isEncryptionAvailable() };
    }

    save(raw: unknown): KeyStatus {
        const key = validateKey(raw);
        if (!this.crypto.isEncryptionAvailable()) {
            throw new KeyStoreError('This computer cannot encrypt the key, so Drift will not save it.');
        }
        this.files.write(this.path, this.crypto.encryptString(key));
        return this.status();
    }

    load(): string | null {
        if (!this.files.exists(this.path)) return null;
        try {
            return this.crypto.decryptString(this.files.read(this.path));
        } catch {
            // Encrypted for another user or machine: treat as missing.
            return null;
        }
    }

    remove(): KeyStatus {
        if (this.files.exists(this.path)) this.files.remove(this.path);
        return this.status();
    }
}
