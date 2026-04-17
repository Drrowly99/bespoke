/**
 * AES-256-GCM token encryption/decryption.
 * KEY: 32-byte hex string (64 chars) from TOKEN_ENCRYPTION_KEY env var.
 * Stored format: iv(24 hex):authTag(32 hex):ciphertext(hex)
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  return Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex');
}

export function encrypt(plaintext) {
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(stored) {
  const [ivHex, tagHex, ctHex] = stored.split(':');
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ctHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
