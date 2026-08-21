// AES-256-GCM encryption for social platform access tokens at rest.
// The key never leaves the server process (env var, not stored in the DB).
const crypto = require('crypto');

function getKey() {
  const hex = process.env.SOCIAL_CREDENTIALS_KEY;
  if (!hex) {
    throw new Error('SOCIAL_CREDENTIALS_KEY is not set on the server.');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('SOCIAL_CREDENTIALS_KEY must be a 64-character hex string (32 bytes).');
  }
  return key;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  };
}

function decrypt({ ciphertext, iv, tag }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final()
  ]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
