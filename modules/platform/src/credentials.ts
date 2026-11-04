import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/*
 * Encryption of integration credentials at rest (architecture §10.4): AES-256-GCM with a key from
 * the environment (`CREDENTIALS_ENCRYPTION_KEY`, 32 random bytes in base64). Every ciphertext is
 * stored with the id of its key (`key_id`), so the key can be rotated: the new key encrypts, the
 * previous ones (`CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS`) still decrypt until every row was
 * re-encrypted.
 *
 * The ciphertext is bound to its row through GCM's additional authenticated data (the context
 * string, e.g. `integration_connections:<orgId>:<connectionId>`): copied to another row or
 * organization it no longer decrypts. Error messages never contain keys, plaintext or ciphertext.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT = 'v1';

/** The credentials could not be decrypted (unknown key id, corrupted data or wrong context). */
export class CredentialDecryptionError extends Error {
  override name = 'CredentialDecryptionError';
}

/** Stable, non-secret id of a key: `sha256:` + the first 16 hex digits of its SHA-256. */
export function credentialKeyId(key: Uint8Array): string {
  return `sha256:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/** Keys published in this repository (`.env.example`, CI). Never acceptable in production. */
const PUBLISHED_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'ZGV2LW9ubHkta2V5LWNoYW5nZS1tZS0wMTIzNDU2Nzg=', // .env.example ("dev-only-key-change-me-…")
  'Y2ktb25seS1rZXktMDEyMzQ1Njc4OWFiY2RlZjAxMjM=', // .github/workflows/ci.yml ("ci-only-key-…")
]);

/**
 * True when a `CREDENTIALS_ENCRYPTION_KEY` (base64) is not fit for production: one of the keys
 * published in this repository, or one that decodes to printable ASCII (a passphrase, not 32
 * random bytes; the chance that random bytes are all printable is about 1e-14). Generate keys with
 * `openssl rand -base64 32`.
 */
export function isWeakCredentialKey(base64: string): boolean {
  const value = base64.trim();
  if (PUBLISHED_CREDENTIAL_KEYS.has(value)) {
    return true;
  }
  return /^[\x20-\x7e]*$/.test(Buffer.from(value, 'base64').toString('latin1'));
}

function decodeKey(base64: string, name: string): Buffer {
  const value = base64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new TypeError(`${name} must be base64`);
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new TypeError(`${name} must decode to exactly ${KEY_BYTES} bytes`);
  }
  return key;
}

export interface EncryptedValue {
  /** `v1.<base64url(iv | tag | ciphertext)>`. */
  ciphertext: string;
  keyId: string;
}

export class CredentialCipher {
  private readonly current: { id: string; key: Buffer };
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(current: Uint8Array, previous: readonly Uint8Array[] = []) {
    for (const key of [current, ...previous]) {
      if (key.length !== KEY_BYTES) {
        throw new TypeError(`Credential keys must be ${KEY_BYTES} bytes`);
      }
    }
    const currentKey = Buffer.from(current);
    this.current = { id: credentialKeyId(currentKey), key: currentKey };
    const keys = new Map<string, Buffer>();
    for (const key of [currentKey, ...previous.map((k) => Buffer.from(k))]) {
      keys.set(credentialKeyId(key), key);
    }
    this.keys = keys;
  }

  /**
   * From the environment's base64 keys: the current one (encrypts and decrypts) and optional
   * previous ones (decrypt only). Throws a TypeError naming the variable, never its value.
   */
  static fromBase64(current: string, previous: readonly string[] = []): CredentialCipher {
    return new CredentialCipher(
      decodeKey(current, 'CREDENTIALS_ENCRYPTION_KEY'),
      previous.map((key) => decodeKey(key, 'CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS')),
    );
  }

  /** Id of the key new ciphertexts use. */
  get keyId(): string {
    return this.current.id;
  }

  hasKey(keyId: string): boolean {
    return this.keys.has(keyId);
  }

  /** Encrypts the JSON of `value` with the current key, bound to `context`. */
  encrypt(value: unknown, context: string): EncryptedValue {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.current.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), body]);
    return { ciphertext: `${FORMAT}.${packed.toString('base64url')}`, keyId: this.current.id };
  }

  /** Decrypts and parses a value of `encrypt` (same context). CredentialDecryptionError otherwise. */
  decrypt(ciphertext: string, keyId: string, context: string): unknown {
    const key = this.keys.get(keyId);
    if (!key) {
      throw new CredentialDecryptionError(
        `Credentials were encrypted with key ${keyId}, which is not configured`,
      );
    }
    const [format, payload, ...rest] = ciphertext.split('.');
    if (format !== FORMAT || payload === undefined || rest.length > 0) {
      throw new CredentialDecryptionError('Unsupported credentials format');
    }
    const packed = Buffer.from(payload, 'base64url');
    if (packed.length < IV_BYTES + TAG_BYTES) {
      throw new CredentialDecryptionError('Credentials are truncated');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, packed.subarray(0, IV_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plain = Buffer.concat([
        decipher.update(packed.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
      return JSON.parse(plain.toString('utf8')) as unknown;
    } catch (error) {
      throw new CredentialDecryptionError(
        'Credentials could not be decrypted (wrong key or context, or corrupted data)',
        { cause: error },
      );
    }
  }
}
