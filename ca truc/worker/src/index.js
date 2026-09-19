import { CORS, HttpError, json, readJson } from './http.js';
import { replaceDoc, writeDoc } from './store.js';
import {
  adminTokenVersion, assertNotLocked, checkAdminPassword, checkJoinCode, checkPassword, hasUnrecognizedToken, isStorageToken,
  issueToken, loginGuardKey, makeJoinCodeRecord, makePasswordRecord, readAuth, readSession, recordLoginResult, updateAuth,
  validateNewPassword,
} from './auth.js';
import {
  DATA_KEY, MAX_DATA_BYTES, forAdmin, forViewer, legacyPasswordHashes, publicInfo, readData, stripSecrets, validateData,
} from './data.js';
import { handleFiles } from './files.js';

const SMALL_BODY_BYTES = 16 * 1024;
const FILE_PREFIXES = ['/api/files', '/files'];

// Thẻ đồng bộ đổi khi dữ liệu hoặc trạng thái mật khẩu thay đổi, để máy khác biết cần tải lại.
const syncTag = (dataEtag, authEtag) => `${dataEtag}.${authEtag}`;

async function requireSession(request, env, role) {
  const { doc: auth, etag: authEtag } = await readAuth(env);
  const session = await readSession(request, env, auth);
  if (!session) throw new HttpError(401, 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  if (role && session.role !== role) throw new HttpError(403, 'Bạn không có quyền thực hiện thao tác này.');
  return { session, auth, authEtag };
}

/* ---------- Đăng nhập ---------- */
async function getPublic(env) {
  const [{ doc: data }, { doc: auth }] = await Promise.all([readData(env), readAuth(env)]);
  return json(publicInfo(data, auth));
}

async function loginAdmin(request, env, password) {
  const guard = loginGuardKey('admin', request);
  await assertNotLocked(env, guard);
  const { doc: auth } = await readAuth(env);
  const ok = await checkAdminPassword(env, auth, password);
  await recordLoginResult(env, guard, ok);
  if (!ok) throw new HttpError(401, 'Sai mật khẩu quản trị.');
  const token = await issueToken(env, { role: 'admin', tv: adminTokenVersion(auth) });
  return json({ token, role: 'admin', usingServerToken: !auth.admin });
}

async function upgradeLegacyRecord(env, employeeId, legacy, password) {
  const upgraded = await makePasswordRecord(password, legacy.tv);
  await updateAuth(env, auth => {
    const current = auth.employees[employeeId];
    if (!current || current.algo !== 'legacy' || current.hash !== legacy.hash) return { next: auth };
    return { next: { ...auth, employees: { ...auth.employees, [employeeId]: upgraded } } };
  });
}

async function loginViewer(request, env, employeeId, password) {
  const [{ doc: data }, { doc: auth }] = await Promise.all([readData(env), readAuth(env)]);
  if (!data.employees.some(emp => emp.id === employeeId)) throw new HttpError(404, 'Không tìm thấy nhân viên.');
  const record = auth.employees[employeeId];
  if (!record) throw new HttpError(409, 'Tài khoản chưa có mật khẩu. Vui lòng tạo mật khẩu.', { needsPassword: true });
  const guard = loginGuardKey(employeeId, request);
  await assertNotLocked(env, guard);
  const ok = await checkPassword(record, password);
  await recordLoginResult(env, guard, ok);
  if (!ok) throw new HttpError(401, 'Sai mật khẩu.');
  if (record.algo === 'legacy') await upgradeLegacyRecord(env, employeeId, record, password);
  const token = await issueToken(env, { role: 'viewer', employeeId, tv: record.tv });
  return json({ token, role: 'viewer', employeeId });
}

async function login(request, env) {
  const body = await readJson(request, SMALL_BODY_BYTES);
  if (body.role === 'admin') return loginAdmin(request, env, body.password);
  if (body.role === 'viewer') return loginViewer(request, env, String(body.employeeId || ''), body.password);
  throw new HttpError(400, 'Yêu cầu đăng nhập không hợp lệ.');
}

// Tạo mật khẩu lần đầu cần mã đơn vị, để người ngoài biết địa chỉ web không tự nhận tài khoản cán bộ.
async function setFirstPassword(request, env) {
  const body = await readJson(request, SMALL_BODY_BYTES);
  const employeeId = String(body.employeeId || '');
  validateNewPassword(body.password);
  const [{ doc: data }, { doc: auth }] = await Promise.all([readData(env), readAuth(env)]);
  if (!data.employees.some(emp => emp.id === employeeId)) throw new HttpError(404, 'Không tìm thấy nhân viên.');
  const guard = loginGuardKey(`join|${employeeId}`, request);
  await assertNotLocked(env, guard);
  const codeOk = await checkJoinCode(auth, body.joinCode);
  await recordLoginResult(env, guard, codeOk);
  if (!codeOk) throw new HttpError(401, 'Mã đơn vị không đúng.');
  const record = await makePasswordRecord(body.password, 0);
  const { result: tv } = await updateAuth(env, auth => {
    if (auth.employees[employeeId]) throw new HttpError(409, 'Tài khoản đã có mật khẩu. Vui lòng đăng nhập.');
    const seq = (auth.seq || 0) + 1;
    return { next: { ...auth, seq, employees: { ...auth.employees, [employeeId]: { ...record, tv: seq } } }, result: seq };
  });
  const token = await issueToken(env, { role: 'viewer', employeeId, tv });
  return json({ token, role: 'viewer', employeeId });
}

/* ---------- Dữ liệu dùng chung ---------- */
async function getData(request, env) {
  const { session, auth, authEtag } = await requireSession(request, env);
  const known = new URL(request.url).searchParams.get('known');
  if (known) {
    const head = await env.FILES.head(DATA_KEY);
    if (head && known === syncTag(head.etag, authEtag)) return json({ unchanged: true });
  }
  const { doc: data, etag } = await readData(env);
  const tag = syncTag(etag, authEtag);
  if (session.role !== 'admin') return json({ data: forViewer(data), version: etag, tag });
  return json({ data: forAdmin(data, auth), version: etag, tag, joinCodeSet: !!auth.joinCode });
}

// Gỡ mật khẩu của nhân viên đã bị xóa; nhận mật khẩu cũ có trong tệp sao lưu của bản offline.
async function syncPasswordsWithEmployees(env, employees, legacyHashes) {
  const ids = new Set(employees.map(emp => emp.id));
  const { etag } = await updateAuth(env, auth => {
    let seq = auth.seq || 0;
    const kept = Object.entries(auth.employees).filter(([id]) => ids.has(id));
    const added = legacyHashes
      .filter(([id]) => ids.has(id) && !auth.employees[id])
      .map(([id, hash]) => [id, { algo: 'legacy', hash, tv: ++seq }]);
    if (kept.length === Object.keys(auth.employees).length && added.length === 0) return { next: auth };
    return { next: { ...auth, seq, employees: Object.fromEntries([...kept, ...added]) } };
  });
  return etag;
}

async function putData(request, env) {
  await requireSession(request, env, 'admin');
  const body = await readJson(request, MAX_DATA_BYTES);
  validateData(body.data);
  const clean = stripSecrets(body.data);
  let version;
  if (body.force === true) {
    version = await replaceDoc(env.FILES, DATA_KEY, clean);
  } else {
    if (typeof body.version !== 'string' || !body.version) throw new HttpError(400, 'Thiếu phiên bản dữ liệu.');
    version = await writeDoc(env.FILES, DATA_KEY, clean, body.version);
    if (!version) throw new HttpError(409, 'Dữ liệu vừa được người khác cập nhật.', { conflict: true });
  }
  const legacy = body.importLegacy === true ? legacyPasswordHashes(body.data) : [];
  const authEtag = await syncPasswordsWithEmployees(env, clean.employees, legacy);
  return json({ version, tag: syncTag(version, authEtag) });
}

/* ---------- Quản trị mật khẩu ---------- */
async function changeAdminPassword(request, env) {
  const { auth } = await requireSession(request, env, 'admin');
  const body = await readJson(request, SMALL_BODY_BYTES);
  const guard = loginGuardKey('admin', request);
  await assertNotLocked(env, guard);
  const ok = await checkAdminPassword(env, auth, body.current);
  await recordLoginResult(env, guard, ok);
  if (!ok) throw new HttpError(403, 'Mật khẩu hiện tại không đúng.');
  validateNewPassword(body.next);
  const record = await makePasswordRecord(body.next, 0);
  const { result: tv } = await updateAuth(env, current => {
    const seq = (current.seq || 0) + 1;
    return { next: { ...current, seq, admin: { ...record, tv: seq } }, result: seq };
  });
  return json({ token: await issueToken(env, { role: 'admin', tv }) });
}

async function setJoinCode(request, env) {
  await requireSession(request, env, 'admin');
  const body = await readJson(request, SMALL_BODY_BYTES);
  const record = await makeJoinCodeRecord(body.code);
  await updateAuth(env, auth => ({ next: { ...auth, joinCode: record } }));
  return json({ ok: true });
}

async function resetEmployeePassword(request, env) {
  await requireSession(request, env, 'admin');
  const body = await readJson(request, SMALL_BODY_BYTES);
  const employeeId = String(body.employeeId || '');
  await updateAuth(env, auth => {
    if (!auth.employees[employeeId]) return { next: auth };
    const { [employeeId]: removed, ...employees } = auth.employees;
    return { next: { ...auth, employees } };
  });
  return json({ ok: true });
}

/* ---------- Kho tệp ---------- */
// Nhận phiên quản trị hoặc mã ADMIN_TOKEN; đoán sai mã nhiều lần thì bị khóa tạm như khi đăng nhập.
async function files(request, env, subpath) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const { doc: auth } = await readAuth(env);
  const session = await readSession(request, env, auth);
  if (session && session.role === 'admin') return handleFiles(request, env, subpath);
  const guard = loginGuardKey('storage', request);
  await assertNotLocked(env, guard);
  if (await isStorageToken(request, env)) return handleFiles(request, env, subpath);
  if (await hasUnrecognizedToken(request, env)) await recordLoginResult(env, guard, false);
  throw new HttpError(401, 'Phiên đăng nhập đã hết hạn hoặc mã truy cập kho lưu trữ không đúng.');
}

async function route(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (pathname === '/api/public' && method === 'GET') return getPublic(env);
  if (pathname === '/api/login' && method === 'POST') return login(request, env);
  if (pathname === '/api/first-password' && method === 'POST') return setFirstPassword(request, env);
  if (pathname === '/api/data' && method === 'GET') return getData(request, env);
  if (pathname === '/api/data' && method === 'PUT') return putData(request, env);
  if (pathname === '/api/admin/password' && method === 'POST') return changeAdminPassword(request, env);
  if (pathname === '/api/admin/reset-password' && method === 'POST') return resetEmployeePassword(request, env);
  if (pathname === '/api/admin/join-code' && method === 'POST') return setJoinCode(request, env);
  const filePrefix = FILE_PREFIXES.find(prefix => pathname === prefix || pathname.startsWith(prefix + '/'));
  if (filePrefix) return files(request, env, pathname.slice(filePrefix.length));
  if (!pathname.startsWith('/api/') && env.ASSETS) return env.ASSETS.fetch(request);
  throw new HttpError(404, 'Không tìm thấy.');
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const headers = FILE_PREFIXES.some(prefix => pathname.startsWith(prefix)) ? CORS : {};
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status, headers);
      console.error('Lỗi không xử lý được', err);
      return json({ error: 'Máy chủ gặp lỗi, vui lòng thử lại.' }, 500, headers);
    }
  },
};
