// Kiểm thử thuật toán gộp 3 chiều trong dongbo.js (chạy: node --test test/merge.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../dongbo.js', import.meta.url), 'utf8');
const noop = () => {};
const sandbox = { document: { addEventListener: noop }, window: { addEventListener: noop }, console };
vm.createContext(sandbox);
vm.runInContext(`${source}\nthis.merge3 = merge3; this.mergeData = mergeData; this.deepEqual = deepEqual;`, sandbox);
const { merge3, mergeData, deepEqual } = sandbox;
const plain = value => JSON.parse(JSON.stringify(value));

const base = () => ({
  orgName: 'Phòng A',
  employees: [{ id: 'e1', name: 'An', phone: '1' }, { id: 'e2', name: 'Bình', unit: 'P1' }],
  schedule: { 'e1|2026-09-01': 'st1', 'e2|2026-09-02': 'st1' },
  dutyConfig: { holidays: { '2026-09': [2] }, rules: { gap: true } },
});

test('không ai sửa thì giữ nguyên', () => {
  assert.deepEqual(plain(merge3(base(), base(), base())), base());
});

test('chỉ máy khác sửa thì lấy bản máy khác', () => {
  const remote = { ...base(), orgName: 'Phòng B' };
  assert.equal(merge3(base(), base(), remote).orgName, 'Phòng B');
});

test('hai bên sửa hai nhân viên khác nhau thì giữ cả hai', () => {
  const local = base();
  local.employees[0].phone = '0901';
  const remote = base();
  remote.employees[1].unit = 'P9';
  const merged = plain(merge3(base(), local, remote));
  assert.equal(merged.employees.find(e => e.id === 'e1').phone, '0901');
  assert.equal(merged.employees.find(e => e.id === 'e2').unit, 'P9');
});

test('hai bên cùng sửa một ô thì giữ bản của máy này', () => {
  const local = base();
  local.employees[0].phone = 'local';
  const remote = base();
  remote.employees[0].phone = 'remote';
  assert.equal(merge3(base(), local, remote).employees[0].phone, 'local');
});

test('thêm nhân viên ở cả hai máy thì giữ đủ, thứ tự theo máy chủ rồi đến mục mới của máy này', () => {
  const local = base();
  local.employees.push({ id: 'e3', name: 'Cường' });
  const remote = base();
  remote.employees.push({ id: 'e4', name: 'Dũng' });
  assert.deepEqual(plain(merge3(base(), local, remote).employees.map(e => e.id)), ['e1', 'e2', 'e4', 'e3']);
});

test('xóa ở một máy, máy kia không đụng tới thì xóa', () => {
  const local = base();
  local.employees = local.employees.filter(e => e.id !== 'e2');
  delete local.schedule['e2|2026-09-02'];
  const remote = base();
  remote.orgName = 'Phòng B';
  const merged = plain(merge3(base(), local, remote));
  assert.deepEqual(merged.employees.map(e => e.id), ['e1']);
  assert.equal(merged.schedule['e2|2026-09-02'], undefined);
  assert.equal(merged.orgName, 'Phòng B');
});

test('máy khác xóa, máy này sửa cùng nhân viên thì giữ lại bản đã sửa', () => {
  const local = base();
  local.employees[1].unit = 'P5';
  const remote = base();
  remote.employees = remote.employees.filter(e => e.id !== 'e2');
  assert.equal(merge3(base(), local, remote).employees.find(e => e.id === 'e2').unit, 'P5');
});

test('lịch trực: hai bên phân công các ô khác nhau đều được giữ', () => {
  const local = base();
  local.schedule['e1|2026-09-03'] = 'st2';
  const remote = base();
  remote.schedule['e2|2026-09-04'] = 'st3';
  delete remote.schedule['e1|2026-09-01'];
  const merged = merge3(base(), local, remote).schedule;
  assert.equal(merged['e1|2026-09-03'], 'st2');
  assert.equal(merged['e2|2026-09-04'], 'st3');
  assert.equal(merged['e1|2026-09-01'], undefined);
});

test('danh sách không có mã (ngày lễ) được coi là một giá trị: máy này thắng khi cùng sửa', () => {
  const local = base();
  local.dutyConfig.holidays['2026-09'] = [2, 3];
  const remote = base();
  remote.dutyConfig.holidays['2026-09'] = [1];
  remote.dutyConfig.rules.gap = false;
  const merged = plain(merge3(base(), local, remote));
  assert.deepEqual(merged.dutyConfig.holidays['2026-09'], [2, 3]);
  assert.equal(merged.dutyConfig.rules.gap, false);
});

test('máy khác xếp ca cho nhân viên mà máy này vừa xóa thì bỏ luôn ô lịch đó', () => {
  const local = base();
  local.employees = local.employees.filter(e => e.id !== 'e2');
  delete local.schedule['e2|2026-09-02'];
  const remote = base();
  remote.schedule['e2|2026-09-10'] = 'st1';
  const merged = plain(mergeData(base(), local, remote));
  assert.deepEqual(merged.employees.map(e => e.id), ['e1']);
  assert.deepEqual(Object.keys(merged.schedule), ['e1|2026-09-01']);
  assert.deepEqual(merged.dutyConfig, base().dutyConfig);
});

test('lưu bị từ chối vì hết phiên thì không còn báo có thay đổi chưa lưu', async () => {
  const element = () => ({ dataset: {}, hidden: false, textContent: '' });
  const ctx = {
    document: { addEventListener: noop, getElementById: element }, window: { addEventListener: noop }, console,
    location: { protocol: 'https:' }, setTimeout, clearTimeout, Blob,
    fetch: async () => ({ ok: false, status: 401, json: async () => ({ error: 'Phiên đăng nhập đã hết hạn.' }) }),
    normalizeData: data => ({ employees: [], shiftTypes: [], schedule: {}, ...data }),
    showScreen: noop, showToast: noop, renderOrgInfo: noop, renderLoginViewerSelect: noop,
  };
  vm.createContext(ctx);
  vm.runInContext(`${source}\nthis.syncState = syncState; this.flushSave = flushSave; DB = normalizeData({});`, ctx);
  ctx.syncState.session = { token: 'the-cu', role: 'admin' };
  ctx.syncState.dirty = true;
  await ctx.flushSave();
  assert.equal(ctx.syncState.session, null);
  assert.equal(ctx.syncState.dirty, false);
});

test('deepEqual không phụ thuộc thứ tự khóa', () => {
  assert.equal(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
});
