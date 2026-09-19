// Kiểm thử tích hợp API. Chạy máy chủ thử trước:
//   wrangler dev --local --port 8799 --var SESSION_SECRET:<ít nhất 32 ký tự> --var ADMIN_TOKEN:server-token-for-tests
// rồi: node --test test/api.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyHash } from '../src/crypto.js';

const BASE = process.env.API_BASE || 'http://127.0.0.1:8799';
const SERVER_TOKEN = process.env.ADMIN_TOKEN || 'server-token-for-tests';
const JOIN_CODE = 'donvi-2026';

async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* không phải JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(BASE + '/api/public')).ok) return;
    } catch { /* máy chủ chưa sẵn sàng */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Máy chủ thử không phản hồi.');
}

const employees = () => [
  { id: 'e1', name: 'Nguyễn Văn An', note: 'nghỉ thai sản', phone: '0901', pwHash: legacyHash('matkhaucu') },
  { id: 'e2', name: 'Trần Thị Bình', phone: '0902' },
];

test('luồng đăng nhập, phân quyền và đồng bộ dữ liệu', async t => {
  await waitForServer();
  let adminToken;

  await t.test('trang công khai chỉ trả tên đơn vị và danh sách tên', async () => {
    const res = await call('/api/public');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['employees', 'orgName', 'orgParent']);
  });

  await t.test('quản trị đăng nhập lần đầu bằng ADMIN_TOKEN, sai mật khẩu bị từ chối', async () => {
    assert.equal((await call('/api/login', { method: 'POST', body: { role: 'admin', password: 'sai' } })).status, 401);
    const ok = await call('/api/login', { method: 'POST', body: { role: 'admin', password: SERVER_TOKEN } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.usingServerToken, true);
    adminToken = ok.json.token;
  });

  await t.test('đọc dữ liệu cần đăng nhập; token bị sửa bị từ chối', async () => {
    assert.equal((await call('/api/data')).status, 401);
    const tampered = adminToken.slice(0, -2) + (adminToken.endsWith('AA') ? 'BB' : 'AA');
    assert.equal((await call('/api/data', { token: tampered })).status, 401);
    const res = await call('/api/data', { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.data.shiftTypes));
  });

  await t.test('nhập tệp sao lưu: bỏ mã băm khỏi dữ liệu, giữ mật khẩu cũ của cán bộ', async () => {
    const data = { employees: employees(), shiftTypes: [], schedule: { 'e1|2026-09-01': 'st1' }, adminPasswordHash: 'hxyz', fileImports: { k: {} } };
    const put = await call('/api/data', { method: 'PUT', token: adminToken, body: { data, force: true, importLegacy: true } });
    assert.equal(put.status, 200, put.text);
    const got = await call('/api/data', { token: adminToken });
    assert.equal(got.json.data.adminPasswordHash, undefined);
    assert.equal(got.json.data.employees[0].pwHash, undefined);
    assert.equal(got.json.data.employees[0].hasPassword, true);
    assert.equal(got.json.data.employees[1].hasPassword, false);
    const pub = await call('/api/public');
    assert.deepEqual(pub.json.employees.map(e => [e.id, e.hasPassword]), [['e1', true], ['e2', false]]);
  });

  let viewer1;
  let viewer2;
  await t.test('cán bộ đăng nhập bằng mật khẩu cũ (được nâng cấp) và tạo mật khẩu lần đầu', async () => {
    const legacy = await call('/api/login', { method: 'POST', body: { role: 'viewer', employeeId: 'e1', password: 'matkhaucu' } });
    assert.equal(legacy.status, 200, legacy.text);
    const again = await call('/api/login', { method: 'POST', body: { role: 'viewer', employeeId: 'e1', password: 'matkhaucu' } });
    assert.equal(again.status, 200, 'mật khẩu vẫn đúng sau khi nâng cấp mã băm');
    viewer1 = again.json.token;
    assert.equal((await call('/api/data', { token: legacy.json.token })).status, 200, 'phiên cũ vẫn hợp lệ sau nâng cấp');

    const needs = await call('/api/login', { method: 'POST', body: { role: 'viewer', employeeId: 'e2', password: 'x' } });
    assert.equal(needs.status, 409);
    assert.equal(needs.json.needsPassword, true);
    const claim = (password, joinCode) => call('/api/first-password', { method: 'POST', body: { employeeId: 'e2', password, joinCode } });
    assert.equal((await claim('binh2026', JOIN_CODE)).status, 403, 'quản trị chưa đặt mã đơn vị thì chưa ai tạo được mật khẩu');
    const setCode = (token, code) => call('/api/admin/join-code', { method: 'POST', token, body: { code } });
    assert.equal((await setCode(viewer1, JOIN_CODE)).status, 403, 'cán bộ không được đặt mã đơn vị');
    assert.equal((await setCode(adminToken, '1234567')).status, 400, 'mã đơn vị quá ngắn');
    assert.equal((await call('/api/data', { token: adminToken })).json.joinCodeSet, false);
    assert.equal((await setCode(adminToken, `  ${JOIN_CODE} `)).status, 200);
    assert.equal((await call('/api/data', { token: adminToken })).json.joinCodeSet, true);
    assert.equal((await claim('binh2026', 'sai-ma-don-vi')).status, 401);
    assert.equal((await claim('binh2026')).status, 401, 'không nhập mã');
    assert.equal((await claim('123', JOIN_CODE)).status, 400);
    const created = await claim('binh2026', JOIN_CODE);
    assert.equal(created.status, 200);
    viewer2 = created.json.token;
    assert.equal((await claim('khac2026', JOIN_CODE)).status, 409);
  });

  await t.test('cán bộ chỉ đọc, không thấy ghi chú cá nhân, không ghi được', async () => {
    const res = await call('/api/data', { token: viewer1 });
    assert.equal(res.status, 200);
    assert.equal(res.json.joinCodeSet, undefined, 'cán bộ không cần biết trạng thái mã đơn vị');
    assert.equal(res.json.data.employees[0].note, undefined);
    assert.equal(res.json.data.employees[0].hasPassword, undefined);
    assert.equal(res.json.data.fileImports, undefined);
    assert.equal(res.json.data.schedule['e1|2026-09-01'], 'st1');
    const put = await call('/api/data', { method: 'PUT', token: viewer1, body: { data: res.json.data, version: res.json.version } });
    assert.equal(put.status, 403);
    assert.equal((await call('/api/admin/reset-password', { method: 'POST', token: viewer1, body: { employeeId: 'e2' } })).status, 403);
    assert.equal((await call('/api/files', { token: viewer1 })).status, 401);
  });

  await t.test('lưu bằng phiên bản cũ báo xung đột; thẻ đồng bộ nhận biết thay đổi', async () => {
    const current = await call('/api/data', { token: adminToken });
    const unchanged = await call('/api/data?known=' + encodeURIComponent(current.json.tag), { token: adminToken });
    assert.deepEqual(unchanged.json, { unchanged: true });

    const data = { ...current.json.data, orgName: 'Phòng A' };
    const first = await call('/api/data', { method: 'PUT', token: adminToken, body: { data, version: current.json.version } });
    assert.equal(first.status, 200);
    const stale = await call('/api/data', { method: 'PUT', token: adminToken, body: { data, version: current.json.version } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.conflict, true);
    const changed = await call('/api/data?known=' + encodeURIComponent(current.json.tag), { token: adminToken });
    assert.equal(changed.json.data.orgName, 'Phòng A');
  });

  await t.test('dữ liệu sai cấu trúc bị từ chối', async () => {
    const bad = await call('/api/data', { method: 'PUT', token: adminToken, body: { data: { employees: 'x' }, force: true } });
    assert.equal(bad.status, 400);
    const dup = { employees: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }], shiftTypes: [], schedule: {} };
    assert.equal((await call('/api/data', { method: 'PUT', token: adminToken, body: { data: dup, force: true } })).status, 400);
  });

  await t.test('loại ca có màu hoặc giờ chèn mã HTML bị từ chối', async () => {
    const current = await call('/api/data', { token: adminToken });
    const shift = { id: 'st1', name: 'Trực ngày', code: 'N', start: '07:30', end: '17:00', color: '#1f5fa8' };
    const withShift = shifts => ({ ...current.json.data, shiftTypes: shifts });
    const put = (shifts, version) => call('/api/data', { method: 'PUT', token: adminToken, body: { data: withShift(shifts), version } });
    for (const bad of [{ color: 'red"><img src=x onerror=alert(1)>' }, { start: '07:30<b>' }, { name: 'x'.repeat(101) }]) {
      const res = await put([{ ...shift, ...bad }], current.json.version);
      assert.equal(res.status, 400, JSON.stringify(bad).slice(0, 40));
    }
    assert.equal((await put([shift], current.json.version)).status, 200);
  });

  await t.test('đặt lại mật khẩu cán bộ làm phiên cũ hết hiệu lực', async () => {
    const before = await call('/api/data', { token: adminToken });
    assert.equal((await call('/api/admin/reset-password', { method: 'POST', token: adminToken, body: { employeeId: 'e2' } })).status, 200);
    assert.equal((await call('/api/data', { token: viewer2 })).status, 401);
    const after = await call('/api/data?known=' + encodeURIComponent(before.json.tag), { token: adminToken });
    assert.equal(after.json.data.employees.find(e => e.id === 'e2').hasPassword, false);
    const recreated = await call('/api/first-password', { method: 'POST', body: { employeeId: 'e2', password: 'binhmoi2026', joinCode: JOIN_CODE } });
    assert.equal(recreated.status, 200);
    assert.equal((await call('/api/data', { token: viewer2 })).status, 401, 'token cũ không sống lại khi tạo mật khẩu mới');
  });

  await t.test('khóa tạm sau 5 lần sai mật khẩu', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await call('/api/login', { method: 'POST', body: { role: 'viewer', employeeId: 'e1', password: 'sai-' + i } });
      assert.equal(res.status, 401);
    }
    const locked = await call('/api/login', { method: 'POST', body: { role: 'viewer', employeeId: 'e1', password: 'matkhaucu' } });
    assert.equal(locked.status, 429);
  });

  await t.test('kho tệp: quản trị và ADMIN_TOKEN dùng được', async () => {
    const upload = await fetch(BASE + '/api/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'text/csv', 'X-File-Name': encodeURIComponent('lịch/../x.csv') },
      body: 'Họ và tên\nA',
    });
    assert.equal(upload.status, 201);
    const { key, name } = await upload.json();
    assert.equal(name, 'x.csv');
    const list = await call('/files', { token: SERVER_TOKEN });
    assert.ok(list.json.files.some(f => f.key === key));
    const download = await fetch(BASE + '/api/files/' + encodeURIComponent(key), { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(await download.text(), 'Họ và tên\nA');
    assert.equal((await call('/api/files/' + encodeURIComponent('app-data/auth.json'), { token: adminToken })).status, 400);
    assert.equal((await call('/api/files/' + encodeURIComponent(key), { method: 'DELETE', token: adminToken })).status, 200);
  });

  await t.test('xóa nhân viên thì phiên của người đó hết hiệu lực', async () => {
    const current = await call('/api/data', { token: adminToken });
    const data = { ...current.json.data, employees: current.json.data.employees.filter(e => e.id !== 'e1') };
    assert.equal((await call('/api/data', { method: 'PUT', token: adminToken, body: { data, version: current.json.version } })).status, 200);
    assert.equal((await call('/api/data', { token: viewer1 })).status, 401);
  });

  await t.test('đổi mật khẩu quản trị: sai mật khẩu cũ bị từ chối, phiên cũ và ADMIN_TOKEN hết hiệu lực', async () => {
    const wrong = await call('/api/admin/password', { method: 'POST', token: adminToken, body: { current: 'sai', next: 'quantri2026' } });
    assert.equal(wrong.status, 403);
    const short = await call('/api/admin/password', { method: 'POST', token: adminToken, body: { current: SERVER_TOKEN, next: '123' } });
    assert.equal(short.status, 400);
    const ok = await call('/api/admin/password', { method: 'POST', token: adminToken, body: { current: SERVER_TOKEN, next: 'quantri2026' } });
    assert.equal(ok.status, 200);
    assert.equal((await call('/api/data', { token: adminToken })).status, 401);
    assert.equal((await call('/api/data', { token: ok.json.token })).status, 200);
    assert.equal((await call('/api/login', { method: 'POST', body: { role: 'admin', password: SERVER_TOKEN } })).status, 401);
    assert.equal((await call('/api/login', { method: 'POST', body: { role: 'admin', password: 'quantri2026' } })).status, 200);
  });

  await t.test('kho tệp: đoán sai mã truy cập nhiều lần bị khóa tạm, phiên quản trị vẫn dùng được', async () => {
    const admin = await call('/api/login', { method: 'POST', body: { role: 'admin', password: 'quantri2026' } });
    for (let i = 0; i < 5; i++) {
      assert.equal((await call('/api/files', { token: adminToken })).status, 401, 'phiên cũ đã thu hồi');
      assert.equal((await call('/api/files')).status, 401, 'không gửi mã');
    }
    assert.equal((await call('/api/files', { token: SERVER_TOKEN })).status, 200, 'phiên hết hạn và yêu cầu không có mã không bị tính là đoán sai');
    for (let i = 0; i < 5; i++) {
      assert.equal((await call('/api/files', { token: 'doan-sai-' + i })).status, 401);
    }
    assert.equal((await call('/api/files', { token: SERVER_TOKEN })).status, 429, 'đúng mã cũng bị chặn khi đang khóa');
    assert.equal((await call('/api/files', { token: admin.json.token })).status, 200);
  });

  await t.test('mã đơn vị: đoán sai nhiều lần bị khóa tạm', async () => {
    const admin = await call('/api/login', { method: 'POST', body: { role: 'admin', password: 'quantri2026' } });
    const current = await call('/api/data', { token: admin.json.token });
    const data = { ...current.json.data, employees: [...current.json.data.employees, { id: 'e3', name: 'Lê Văn Cường' }] };
    assert.equal((await call('/api/data', { method: 'PUT', token: admin.json.token, body: { data, version: current.json.version } })).status, 200);
    const claim = joinCode => call('/api/first-password', { method: 'POST', body: { employeeId: 'e3', password: 'cuong2026', joinCode } });
    for (let i = 0; i < 5; i++) {
      assert.equal((await claim('doan-sai-' + i)).status, 401);
    }
    assert.equal((await claim(JOIN_CODE)).status, 429, 'đúng mã cũng bị chặn khi đang khóa');
  });

  await t.test('trang web được phục vụ kèm header bảo mật; tệp nội bộ không bị lộ', async () => {
    const home = await call('/');
    assert.equal(home.status, 200);
    assert.match(home.text, /HỆ THỐNG QUẢN LÝ LỊCH TRỰC/);
    assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/);
    for (const path of ['/worker/src/index.js', '/worker/wrangler.toml', '/implementation_plan.md', '/.claude/settings.local.json', '/.assetsignore']) {
      const res = await call(path);
      assert.ok(!res.text.includes('export default') && !res.text.includes('permissions') && !res.text.includes('r2_buckets'), path);
    }
  });
});
