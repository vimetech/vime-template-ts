import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CredentialCipher,
  CredentialDecryptionError,
  credentialKeyId,
  isWeakCredentialKey,
} from './credentials';

const keyA = randomBytes(32);
const keyB = randomBytes(32);
const secret = { accountId: '12345', apiKey: 'super-secret-api-key' };
const context = 'integration_connections:org-1:conn-1';

describe('CredentialCipher (AES-256-GCM)', () => {
  it('round-trips JSON values bound to their context, with a fresh IV each time', () => {
    const cipher = new CredentialCipher(keyA);
    const first = cipher.encrypt(secret, context);
    const second = cipher.encrypt(secret, context);
    expect(first.keyId).toBe(credentialKeyId(keyA));
    expect(first.keyId).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(first.ciphertext).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.ciphertext).not.toContain('secret');
    expect(cipher.decrypt(first.ciphertext, first.keyId, context)).toEqual(secret);
    expect(cipher.decrypt(second.ciphertext, second.keyId, context)).toEqual(secret);
  });

  it('refuses another context (row or organization), a tampered body and an unknown key', () => {
    const cipher = new CredentialCipher(keyA);
    const { ciphertext, keyId } = cipher.encrypt(secret, context);
    expect(() => cipher.decrypt(ciphertext, keyId, 'integration_connections:org-2:conn-1')).toThrow(
      CredentialDecryptionError,
    );
    const body = Buffer.from(ciphertext.slice(3), 'base64url');
    body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 1;
    expect(() => cipher.decrypt(`v1.${body.toString('base64url')}`, keyId, context)).toThrow(
      /could not be decrypted/,
    );
    expect(() => cipher.decrypt(ciphertext, credentialKeyId(keyB), context)).toThrow(
      /not configured/,
    );
    expect(() => cipher.decrypt('v2.abc', keyId, context)).toThrow(/Unsupported/);
    expect(() => cipher.decrypt('v1.abc', keyId, context)).toThrow(/truncated/);
    // Messages never carry the secret.
    try {
      cipher.decrypt(ciphertext, keyId, 'other');
    } catch (error) {
      expect(String(error)).not.toContain(secret.apiKey);
    }
  });

  it('supports key rotation: previous keys still decrypt, the new key encrypts', () => {
    const old = new CredentialCipher(keyA);
    const stored = old.encrypt(secret, context);
    const rotated = new CredentialCipher(keyB, [keyA]);
    expect(rotated.keyId).toBe(credentialKeyId(keyB));
    expect(rotated.hasKey(credentialKeyId(keyA))).toBe(true);
    expect(rotated.decrypt(stored.ciphertext, stored.keyId, context)).toEqual(secret);
    expect(rotated.encrypt(secret, context).keyId).toBe(credentialKeyId(keyB));
  });

  it('reads base64 keys from the environment and validates them without echoing them', () => {
    const cipher = CredentialCipher.fromBase64(keyA.toString('base64'), [keyB.toString('base64')]);
    expect(cipher.keyId).toBe(credentialKeyId(keyA));
    expect(cipher.hasKey(credentialKeyId(keyB))).toBe(true);
    expect(() => CredentialCipher.fromBase64('not base64!')).toThrow(
      /CREDENTIALS_ENCRYPTION_KEY must be base64/,
    );
    expect(() => CredentialCipher.fromBase64(randomBytes(16).toString('base64'))).toThrow(
      /exactly 32 bytes/,
    );
    expect(() =>
      CredentialCipher.fromBase64(keyA.toString('base64'), [randomBytes(8).toString('base64')]),
    ).toThrow(/CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS/);
  });
});

describe('isWeakCredentialKey', () => {
  it('flags the keys published in this repository and passphrase-like keys', () => {
    // .env.example and CI.
    expect(isWeakCredentialKey('ZGV2LW9ubHkta2V5LWNoYW5nZS1tZS0wMTIzNDU2Nzg=')).toBe(true);
    expect(isWeakCredentialKey(' Y2ktb25seS1rZXktMDEyMzQ1Njc4OWFiY2RlZjAxMjM= ')).toBe(true);
    // 32 printable ASCII characters: a passphrase, not random bytes.
    expect(isWeakCredentialKey(Buffer.from('a'.repeat(32)).toString('base64'))).toBe(true);
  });

  it('accepts random keys', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(isWeakCredentialKey(randomBytes(32).toString('base64'))).toBe(false);
    }
  });
});
