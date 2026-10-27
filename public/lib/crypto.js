/**
 * WebCrypto helpers (port of SankTec's crypto.util.ts). Works in browsers and Node >= 20.
 *
 * Scheme:
 *  - random 256-bit AES-GCM data key per device;
 *  - the data key is wrapped with a KEK derived from the user's password (PBKDF2-SHA256, random salt);
 *  - every payload is stored as base64(iv ‖ ciphertext) with a fresh 12-byte IV;
 *  - the unwrapped data key is imported NON-EXTRACTABLE and kept in memory only.
 */
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const bytesToBase64 = bytes => btoa(String.fromCharCode(...bytes));
export const base64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const toHex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text) {
  return toHex(await subtle.digest('SHA-256', enc.encode(text)));
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** Password → key-encryption-key. */
export async function deriveKek(password, salt, iterations) {
  const material = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Non-extractable: code can use the key but can never read its bytes back. */
export const importDataKey = raw => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

/** HMAC key (domain-separated from the AES use of the same bytes) used to blind cache keys. */
export async function importHmacKey(raw) {
  const material = await subtle.digest('SHA-256', new Uint8Array([...enc.encode('cache-key'), ...raw]));
  return subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacHex(key, text) {
  return toHex(await subtle.sign('HMAC', key, enc.encode(text)));
}

export async function aesEncryptBytes(key, plain) {
  const iv = randomBytes(12);
  const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return bytesToBase64(out);
}

/** Throws on tampering or wrong key (GCM authentication). */
export async function aesDecryptBytes(key, payload) {
  const data = base64ToBytes(payload);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, key, data.slice(12)));
}

export const aesEncryptJson = (key, value) => aesEncryptBytes(key, enc.encode(JSON.stringify(value)));
export const aesDecryptJson = async (key, payload) => JSON.parse(dec.decode(await aesDecryptBytes(key, payload)));
