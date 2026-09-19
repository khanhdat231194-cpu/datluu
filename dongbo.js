/* ===================== ĐỒNG BỘ VỚI MÁY CHỦ (nhiều người dùng) ===================== */
const SESSION_KEY = 'catruc_session';
const MIN_PASSWORD_LENGTH = 6;
const MIN_JOIN_CODE_LENGTH = 8;
const SAVE_DELAY_MS = 800;
const SAVE_RETRY_MS = 5000;
const POLL_ADMIN_MS = 30000;
const POLL_VIEWER_MS = 60000;
const REFRESH_RETRY_MS = 2000;
const MAX_SAVE_ATTEMPTS = 3;
const SYNC_TEXT = {
  saved: 'Đã lưu lên máy chủ',
  pending: 'Có thay đổi chưa lưu',
  saving: 'Đang lưu...',
  error: 'Chưa lưu được, đang thử lại',
  offline: 'Mất kết nối máy chủ'
};

const syncState = {
  session: null,        // {token, role, employeeId}
  publicEmployees: [],  // danh sách tên cho màn hình đăng nhập
  base: null,           // bản dữ liệu khớp với máy chủ ở lần đồng bộ gần nhất
  version: null,
  tag: null,
  joinCodeSet: false,   // quản trị đã đặt mã đơn vị chưa (chỉ máy chủ trả cho quản trị)
  dirty: false,
  savePromise: null,
  saveTimer: null,
  pollTimer: null,
  refreshTimer: null
};

class ApiError extends Error {
  constructor(message, status, payload){
    super(message);
    this.status = status;
    this.payload = payload || {};
  }
}

/* ---------- Gọi API ---------- */
async function apiFetch(path, options = {}){
  const headers = {...(options.headers || {})};
  if(syncState.session) headers.Authorization = 'Bearer ' + syncState.session.token;
  let body = options.body;
  if(body !== undefined && !(body instanceof Blob)){
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  let res;
  try{
    res = await fetch(path, {...options, headers, body});
  }catch(err){
    throw new ApiError('Không kết nối được máy chủ. Vui lòng kiểm tra mạng Internet.', 0);
  }
  if(res.ok) return res;
  let payload = {};
  try{ payload = await res.json(); }catch(e){ /* phản hồi không phải JSON */ }
  if(res.status === 401 && syncState.session) handleSessionExpired();
  throw new ApiError(payload.error || `Máy chủ báo lỗi (${res.status}).`, res.status, payload);
}

/* ---------- Phiên đăng nhập ---------- */
function readStoredSession(){
  try{ return JSON.parse(sessionStorage.getItem(SESSION_KEY)); }catch(e){ return null; }
}

function storeSession(session){
  syncState.session = session;
  try{
    if(session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  }catch(e){ /* trình duyệt chặn bộ nhớ phiên: chỉ giữ đăng nhập trong trang đang mở */ }
}

function isAdminSession(){ return !!syncState.session && syncState.session.role === 'admin'; }

async function loginWith(body){
  const result = await (await apiFetch('/api/login', {method: 'POST', body})).json();
  await startSession({token: result.token, role: result.role, employeeId: result.employeeId || null});
  return result;
}

async function createFirstPassword(employeeId, password, joinCode){
  const result = await (await apiFetch('/api/first-password', {method: 'POST', body: {employeeId, password, joinCode}})).json();
  await startSession({token: result.token, role: 'viewer', employeeId});
}

async function startSession(session){
  storeSession(session);
  try{
    adoptServerData(await fetchServerData());
  }catch(err){
    storeSession(null);
    throw err;
  }
  if(session.role === 'viewer' && !findEmployee(session.employeeId)){
    endSession();
    throw new ApiError('Tài khoản không còn trong danh sách nhân viên.', 404);
  }
  currentUser = session.role === 'admin' ? {role: 'admin'} : {role: 'viewer', employeeId: session.employeeId};
  setSyncStatus(syncState.dirty ? 'pending' : 'saved');
  schedulePoll();
  if(session.role === 'admin') enterAdmin(); else enterViewer();
}

function endSession(){
  clearTimeout(syncState.saveTimer);
  clearTimeout(syncState.pollTimer);
  clearTimeout(syncState.refreshTimer);
  storeSession(null);
  Object.assign(syncState, {base: null, version: null, tag: null, joinCodeSet: false, dirty: false});
  currentUser = null;
  DB = normalizeData({});
}

async function logout(){
  await flushSave();
  if(syncState.dirty){
    confirmDialog('Một số thay đổi chưa lưu được lên máy chủ và sẽ bị mất. Vẫn đăng xuất?', finishLogout);
    return;
  }
  finishLogout();
}

function finishLogout(){
  endSession();
  showScreen('login');
  loadPublicInfo();
}

function handleSessionExpired(){
  if(!syncState.session) return;
  endSession();
  showScreen('login');
  showToast('Phiên đăng nhập đã hết hạn hoặc mật khẩu đã thay đổi. Vui lòng đăng nhập lại.');
  loadPublicInfo();
}

async function changeAdminPassword(current, next){
  const result = await (await apiFetch('/api/admin/password', {method: 'POST', body: {current, next}})).json();
  storeSession({...syncState.session, token: result.token});
}

async function setJoinCode(code){
  await apiFetch('/api/admin/join-code', {method: 'POST', body: {code}});
  syncState.joinCodeSet = true;
}

async function resetEmployeePassword(employeeId){
  await apiFetch('/api/admin/reset-password', {method: 'POST', body: {employeeId}});
  const emp = findEmployee(employeeId);
  if(emp) emp.hasPassword = false;
}

/* ---------- Tải và lưu dữ liệu ---------- */
function jsonClone(value){ return JSON.parse(JSON.stringify(value)); }

async function fetchServerData(){
  return (await apiFetch('/api/data')).json();
}

function adoptServerData(payload){
  DB = normalizeData(payload.data);
  syncState.base = jsonClone(DB);
  syncState.version = payload.version;
  syncState.tag = payload.tag;
  syncState.joinCodeSet = !!payload.joinCodeSet;
  ensureDutySetup();
  // Dữ liệu mới tạo cần bổ sung cấu hình xếp lịch mặc định lên máy chủ.
  if(isAdminSession() && !deepEqual(jsonClone(DB), syncState.base)) markDataChanged();
}

function markDataChanged(){
  if(!isAdminSession()) return;
  syncState.dirty = true;
  setSyncStatus('pending');
  scheduleSave(SAVE_DELAY_MS);
}

function scheduleSave(delay){
  clearTimeout(syncState.saveTimer);
  syncState.saveTimer = setTimeout(flushSave, delay);
}

function flushSave(){
  clearTimeout(syncState.saveTimer);
  if(syncState.savePromise) return syncState.savePromise.then(() => flushSave());
  if(!syncState.dirty || !isAdminSession()) return Promise.resolve(true);
  syncState.savePromise = pushChanges().finally(() => { syncState.savePromise = null; });
  return syncState.savePromise;
}

async function pushChanges(){
  syncState.dirty = false;
  setSyncStatus('saving');
  try{
    await putWithMerge();
  }catch(err){
    // 401: phiên đã bị đóng và dữ liệu trên máy đã được xóa, không còn gì để lưu lại.
    if(err.status !== 401){
      syncState.dirty = true;
      setSyncStatus('error', err.message);
      scheduleSave(SAVE_RETRY_MS);
    }
    return false;
  }
  if(syncState.dirty) scheduleSave(SAVE_DELAY_MS);
  setSyncStatus(syncState.dirty ? 'pending' : 'saved');
  return true;
}

async function putWithMerge(){
  for(let attempt = 1; ; attempt++){
    const snapshot = jsonClone(DB);
    try{
      const saved = await (await apiFetch('/api/data', {method: 'PUT', body: {version: syncState.version, data: snapshot}})).json();
      syncState.base = snapshot;
      syncState.version = saved.version;
      syncState.tag = saved.tag;
      return;
    }catch(err){
      if(err.status !== 409 || attempt >= MAX_SAVE_ATTEMPTS) throw err;
      await mergeRemoteChanges();
    }
  }
}

// Người khác vừa lưu: gộp thay đổi của họ với thay đổi trên máy này rồi lưu lại.
async function mergeRemoteChanges(){
  const payload = await fetchServerData();
  const remote = normalizeData(payload.data);
  const local = DB;
  DB = mergeData(syncState.base, local, remote);
  syncState.base = jsonClone(remote);
  syncState.version = payload.version;
  syncState.tag = payload.tag;
  syncState.joinCodeSet = !!payload.joinCodeSet;
  if(!deepEqual(DB, local)) refreshViewsWhenIdle();
}

// Nhập tệp sao lưu: thay toàn bộ dữ liệu trên máy chủ.
async function replaceServerData(data){
  clearTimeout(syncState.saveTimer);
  if(syncState.savePromise) await syncState.savePromise;
  syncState.dirty = false;
  await apiFetch('/api/data', {method: 'PUT', body: {data, force: true, importLegacy: true}});
  adoptServerData(await fetchServerData());
  setSyncStatus(syncState.dirty ? 'pending' : 'saved');
  refreshCurrentViews();
}

/* ---------- Gộp 3 chiều ---------- */
function isPlainObject(value){ return value !== null && typeof value === 'object' && !Array.isArray(value); }

function deepEqual(a, b){
  if(a === b) return true;
  if(Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if(isPlainObject(a) && isPlainObject(b)){
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function isIdList(value){ return Array.isArray(value) && value.every(x => isPlainObject(x) && typeof x.id === 'string'); }

function mergeIdLists(base, local, remote){
  const index = list => new Map(list.map(x => [x.id, x]));
  const b = index(base), l = index(local), r = index(remote);
  const ids = [...remote.map(x => x.id), ...local.map(x => x.id).filter(id => !r.has(id))];
  return ids.map(id => merge3(b.get(id), l.get(id), r.get(id))).filter(x => x !== undefined);
}

// Giữ thay đổi của cả máy này và máy khác; nếu hai bên cùng sửa một ô thì giữ bản của máy này.
// Danh sách có mã (nhân viên, loại ca) được gộp theo mã; undefined nghĩa là mục đã bị xóa.
function merge3(base, local, remote){
  if(deepEqual(local, base)) return remote;
  if(deepEqual(remote, base) || deepEqual(local, remote)) return local;
  if(isPlainObject(local) && isPlainObject(remote)){
    const b = isPlainObject(base) ? base : {};
    const merged = {};
    new Set([...Object.keys(remote), ...Object.keys(local)]).forEach(k => {
      const value = merge3(b[k], local[k], remote[k]);
      if(value !== undefined) merged[k] = value;
    });
    return merged;
  }
  if(isIdList(local) && isIdList(remote)) return mergeIdLists(isIdList(base) ? base : [], local, remote);
  return local;
}

// Gộp theo từng ô có thể giữ lại ô lịch mà máy khác vừa xếp cho nhân viên đã bị xóa ở máy này; bỏ các ô đó.
function mergeData(base, local, remote){
  const merged = merge3(base, local, remote);
  const ids = new Set(merged.employees.map(emp => emp.id));
  const schedule = Object.fromEntries(
    Object.entries(merged.schedule).filter(([key]) => ids.has(key.slice(0, key.lastIndexOf('|'))))
  );
  return {...merged, schedule};
}

/* ---------- Tự động cập nhật thay đổi của người khác ---------- */
function schedulePoll(){
  clearTimeout(syncState.pollTimer);
  if(!syncState.session) return;
  syncState.pollTimer = setTimeout(pollServer, isAdminSession() ? POLL_ADMIN_MS : POLL_VIEWER_MS);
}

async function pollServer(){
  clearTimeout(syncState.pollTimer);
  if(!syncState.session) return;
  try{
    if(document.hidden || syncState.dirty || syncState.savePromise) return;
    const tag = syncState.tag;
    const payload = await (await apiFetch('/api/data?known=' + encodeURIComponent(tag || ''))).json();
    if(isAdminSession() && !syncState.dirty && !syncState.savePromise) setSyncStatus('saved');
    // Bỏ qua nếu trong lúc chờ đã có sửa đổi mới; lần lưu kế tiếp sẽ tự gộp.
    if(payload.unchanged || syncState.dirty || syncState.savePromise || syncState.tag !== tag) return;
    adoptServerData(payload);
    refreshViewsWhenIdle();
  }catch(err){
    if(err.status !== 401 && isAdminSession() && !syncState.dirty) setSyncStatus('offline', err.message);
  }finally{
    schedulePoll();
  }
}

function isUserEditing(){
  const modalOpen = [...document.querySelectorAll('.modal-overlay')].some(m => m.style.display === 'flex');
  const el = document.activeElement;
  return modalOpen || (!!el && el.matches('input, select, textarea') && !el.closest('#screen-login'));
}

// Không vẽ lại khi người dùng đang gõ hoặc đang mở hộp thoại, để không mất nội dung đang nhập.
function refreshViewsWhenIdle(){
  clearTimeout(syncState.refreshTimer);
  if(isUserEditing()){
    syncState.refreshTimer = setTimeout(refreshViewsWhenIdle, REFRESH_RETRY_MS);
    return;
  }
  refreshCurrentViews();
}

function refreshCurrentViews(){
  if(!syncState.session) return;
  renderOrgInfo();
  if(isAdminSession()){
    refreshAdminViews();
    renderJoinCodeStatus();
    return;
  }
  if(!findEmployee(syncState.session.employeeId)){
    handleSessionExpired();
    return;
  }
  renderViewerCalendar();
  initViewerTrackingSelectors();
  renderViewerTrackingTable();
}

function setSyncStatus(state, detail){
  const el = document.getElementById('sync-status');
  if(!el) return;
  el.dataset.state = state;
  el.textContent = SYNC_TEXT[state];
  el.title = detail || '';
}

/* ---------- Màn hình đăng nhập ---------- */
async function loadPublicInfo(){
  const notice = document.getElementById('login-notice');
  try{
    const info = await (await apiFetch('/api/public')).json();
    syncState.publicEmployees = info.employees;
    if(!syncState.session){
      DB.orgParent = info.orgParent;
      DB.orgName = info.orgName;
    }
    notice.hidden = true;
  }catch(err){
    syncState.publicEmployees = [];
    notice.textContent = location.protocol === 'file:'
      ? 'Trang đang được mở trực tiếp từ tệp trên máy nên không có dữ liệu chung. Hãy mở bằng địa chỉ web của hệ thống.'
      : err.message;
    notice.hidden = false;
  }
  renderOrgInfo();
  renderLoginViewerSelect();
}

function publicEmployee(id){ return syncState.publicEmployees.find(e => e.id === id) || null; }

document.addEventListener('DOMContentLoaded', async () => {
  window.addEventListener('beforeunload', e => {
    if(syncState.dirty || syncState.savePromise){
      e.preventDefault();
      e.returnValue = '';
    }
  });
  // Trình duyệt kìm bộ hẹn giờ của tab nền, nên lưu ngay khi người dùng chuyển tab hoặc rời trang.
  document.addEventListener('visibilitychange', () => {
    if(document.hidden) flushSave();
    else if(syncState.session) pollServer();
  });
  window.addEventListener('pagehide', () => { flushSave(); });
  await loadPublicInfo();
  const stored = readStoredSession();
  if(stored && stored.token){
    try{
      await startSession(stored);
    }catch(err){
      showScreen('login');
      showToast(err.message);
    }
  }
});
