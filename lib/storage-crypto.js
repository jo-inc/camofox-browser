/**
 * Encryption at rest for saved browser sessions (cookies and local storage).
 *
 * AES-256-GCM with a fresh random 12-byte IV per write. GCM authenticates the
 * data, so a wrong key or a modified file fails to decrypt instead of loading
 * bad data.
 *
 * File format: "CFX1" (4 bytes) | iv (12) | auth tag (16) | ciphertext.
 *
 * The key comes from CAMOFOX_STORAGE_KEY: 32 random bytes, base64 encoded.
 * Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Pure functions only. Errors never include file contents or the key.
 */
import crypto from 'node:crypto';

const MAGIC = Buffer.from('CFX1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES;

/**
 * @param {string} value base64 text, or empty
 * @returns {Buffer|null} the 32-byte key, or null when no key is configured
 */
export function parseStorageKey(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32) {
    throw new Error('CAMOFOX_STORAGE_KEY must be 32 random bytes, base64 encoded');
  }
  return key;
}

export function encryptJson(key, value) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptJson(key, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_BYTES || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not an encrypted storage file');
  }
  const iv = buffer.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = buffer.subarray(MAGIC.length + IV_BYTES, HEADER_BYTES);
  const body = buffer.subarray(HEADER_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}
