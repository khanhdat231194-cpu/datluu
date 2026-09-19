const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hmacKeys = new Map();

export function toB64url(bytes) {
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '==='.slice((base64.length + 3) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export const textToB64url = text => toB64url(encoder.encode(text));
export const b64urlToText = text => decoder.decode(fromB64url(text));

// So sánh chuỗi không để lộ thời gian (băm trước để hai bên luôn dài bằng nhau).
export async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(a))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(b))),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

// Hàm băm của bản chạy offline cũ; chỉ dùng để nhận mật khẩu cũ rồi nâng cấp sang PBKDF2.
export function legacyHash(text) {
  const str = String(text);
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return 'h' + Math.abs(hash).toString(36) + str.length;
}

async function hmacKey(secret) {
  if (!hmacKeys.has(secret)) {
    hmacKeys.set(secret, crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  }
  return hmacKeys.get(secret);
}

export async function hmacSign(secret, text) {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(text));
  return toB64url(new Uint8Array(signature));
}

export async function hmacVerify(secret, text, signature) {
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(signature), encoder.encode(text));
  } catch {
    return false;
  }
}
