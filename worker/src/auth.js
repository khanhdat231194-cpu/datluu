import { HttpError } from './http.js';
import { readDoc, updateDoc } from './store.js';
import { b64urlToText, fromB64url, hmacSign, hmacVerify, legacyHash, pbkdf2, safeEqual, textToB64url, toB64url } from './crypto.js';

export const AUTH_KEY = 'app-data/auth.json';
const GUARD_KEY = 'app-data/login-guard.json';
export const MIN_PASSWORD_LENGTH = 6;
const MIN_JOIN_CODE_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
// Giới hạn thời gian CPU của Cloudflare Workers không cho dùng số vòng lớn; bù lại bằng khóa tạm khi đăng nhập sai.
const PBKDF2_ITERATIONS = 10000;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;

// auth.json: { seq, admin: record|null, joinCode: record|null, employees: { [empId]: record } }
// record: { algo: 'pbkdf2'|'legacy', hash, salt?, iter?, tv } — tv lấy từ seq, đổi mỗi lần đặt mật khẩu để vô hiệu phiên cũ.
// joinCode: mã chung của đơn vị, cán bộ phải nhập đúng mới tạo được mật khẩu lần đầu.
const emptyAuth = () => ({ seq: 0, admin: null, joinCode: null, employees: {} });

export const readAuth = env => readDoc(env.FILES, AUTH_KEY, emptyAuth);
export const updateAuth = (env, mutate) => updateDoc(env.FILES, AUTH_KEY, emptyAuth, mutate);

export function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Mật khẩu cần ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) throw new HttpError(400, 'Mật khẩu quá dài.');
}

export async function makePasswordRecord(password, tv) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return { algo: 'pbkdf2', iter: PBKDF2_ITERATIONS, salt: toB64url(salt), hash: toB64url(hash), tv };
}

export async function checkPassword(record, password) {
  if (!record || typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
  if (record.algo === 'legacy') return safeEqual(legacyHash(password), record.hash);
  if (record.algo === 'pbkdf2') {
    const hash = await pbkdf2(password, fromB64url(record.salt), record.iter);
    return safeEqual(toB64url(hash), record.hash);
  }
  return false;
}

// Khi chưa đặt mật khẩu quản trị, đăng nhập lần đầu bằng mã truy cập máy chủ (secret ADMIN_TOKEN).
export async function checkAdminPassword(env, auth, password) {
  if (auth.admin) return checkPassword(auth.admin, password);
  if (!env.ADMIN_TOKEN) throw new HttpError(503, 'Máy chủ chưa được cấu hình mã truy cập quản trị (ADMIN_TOKEN).');
  return typeof password === 'string' && password.length > 0 && safeEqual(password, env.ADMIN_TOKEN);
}

export const adminTokenVersion = auth => (auth.admin ? auth.admin.tv : 0);

const normalizeJoinCode = code => (typeof code === 'string' ? code.trim() : '');

export async function makeJoinCodeRecord(code) {
  const normalized = normalizeJoinCode(code);
  if (normalized.length < MIN_JOIN_CODE_LENGTH) throw new HttpError(400, `Mã đơn vị cần ít nhất ${MIN_JOIN_CODE_LENGTH} ký tự.`);
  if (normalized.length > MAX_PASSWORD_LENGTH) throw new HttpError(400, 'Mã đơn vị quá dài.');
  return makePasswordRecord(normalized, 0);
}

export async function checkJoinCode(auth, code) {
  if (!auth.joinCode) {
    throw new HttpError(403, 'Quản trị chưa thiết lập mã đơn vị nên chưa thể tạo mật khẩu. Vui lòng liên hệ quản trị.');
  }
  const normalized = normalizeJoinCode(code);
  return !!normalized && checkPassword(auth.joinCode, normalized);
}

function sessionSecret(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new HttpError(503, 'Máy chủ chưa được cấu hình khóa phiên đăng nhập (SESSION_SECRET).');
  }
  return env.SESSION_SECRET;
}

export async function issueToken(env, { role, employeeId = null, tv }) {
  const payload = textToB64url(JSON.stringify({ r: role, e: employeeId, v: tv, x: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${await hmacSign(sessionSecret(env), payload)}`;
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// Nội dung thẻ do máy chủ ký (kể cả thẻ đã hết hạn hoặc bị thu hồi); null nếu chữ ký không đúng.
async function signedClaims(request, env) {
  const [payload, signature, extra] = bearerToken(request).split('.');
  if (!payload || !signature || extra !== undefined) return null;
  if (!(await hmacVerify(sessionSecret(env), payload, signature))) return null;
  try {
    return JSON.parse(b64urlToText(payload));
  } catch {
    return null;
  }
}

// Có gửi mã nhưng không phải thẻ do máy chủ ký: coi là đoán mã truy cập.
export async function hasUnrecognizedToken(request, env) {
  return !!bearerToken(request) && !(await signedClaims(request, env));
}

export async function readSession(request, env, auth) {
  const claims = await signedClaims(request, env);
  if (!claims || typeof claims.x !== 'number' || claims.x < Date.now()) return null;
  if (claims.r === 'admin') return claims.v === adminTokenVersion(auth) ? { role: 'admin' } : null;
  if (claims.r === 'viewer') {
    const record = auth.employees[claims.e];
    return record && record.tv === claims.v ? { role: 'viewer', employeeId: claims.e } : null;
  }
  return null;
}

// Mã ADMIN_TOKEN vẫn dùng được cho các công cụ gọi thẳng kho tệp như trước.
export async function isStorageToken(request, env) {
  const token = bearerToken(request);
  return !!env.ADMIN_TOKEN && !!token && safeEqual(token, env.ADMIN_TOKEN);
}

/* ---------- Khóa tạm khi đăng nhập sai nhiều lần (theo tài khoản + địa chỉ IP) ---------- */
export function loginGuardKey(account, request) {
  return `${account}|${request.headers.get('CF-Connecting-IP') || 'local'}`;
}

export async function assertNotLocked(env, key) {
  const { doc } = await readDoc(env.FILES, GUARD_KEY, () => ({}));
  const entry = doc[key];
  if (entry && entry.until > Date.now()) {
    const minutes = Math.ceil((entry.until - Date.now()) / 60000);
    throw new HttpError(429, `Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau ${minutes} phút.`);
  }
}

export async function recordLoginResult(env, key, success) {
  await updateDoc(env.FILES, GUARD_KEY, () => ({}), doc => {
    if (success && !doc[key]) return { next: doc };
    const now = Date.now();
    const next = Object.fromEntries(
      Object.entries(doc).filter(([k, v]) => k !== key && (v.until > now || v.last > now - LOCK_MS))
    );
    if (!success) {
      const recent = doc[key] && doc[key].last > now - LOCK_MS ? doc[key].fails : 0;
      const fails = recent + 1;
      next[key] = fails >= MAX_FAILED_LOGINS ? { fails: 0, until: now + LOCK_MS, last: now } : { fails, until: 0, last: now };
    }
    return { next };
  });
}
