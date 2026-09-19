/* ===================== Data layer ===================== */
const WEEKDAY_LABELS = ['CN','T2','T3','T4','T5','T6','T7'];
const MONTH_NAMES = ['Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6','Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12'];
const DUTY_ROLES = [
  {key:'lanhdao', label:'Lãnh đạo'},
  {key:'truongca', label:'Trưởng ca'},
  {key:'ksv', label:'Kiểm sát viên'},
  {key:'vanthu', label:'Văn thư'},
  {key:'laixe', label:'Lái xe'}
];
const EMP_STATUSES = [
  {key:'active', label:'Đang tham gia trực'},
  {key:'rotation', label:'Tạm nghỉ trực'},
  {key:'leave', label:'Nghỉ chế độ, lý do khác'},
  {key:'exempt', label:'Không tham gia trực'}
];
function roleLabel(key){ const r = DUTY_ROLES.find(x => x.key === key); return r ? r.label : ''; }
function statusLabel(key){ const s = EMP_STATUSES.find(x => x.key === (key || 'active')); return s ? s.label : ''; }

// Sắp xếp họ tên theo thứ tự tiếng Việt: tên chính (từ cuối) → tên đệm → họ.
const NAME_COLLATOR = new Intl.Collator('vi', {numeric: true});
function nameSortParts(name){
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if(words.length < 2) return [words[0] || '', '', ''];
  return [words[words.length - 1], words.slice(1, -1).join(' '), words[0]];
}
function compareNames(a, b){
  const pa = nameSortParts(a), pb = nameSortParts(b);
  for(let i = 0; i < pa.length; i++){
    const diff = NAME_COLLATOR.compare(pa[i], pb[i]);
    if(diff) return diff;
  }
  return 0;
}

function uid(prefix){
  return prefix + '_' + Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4);
}

// Dữ liệu được lưu chung trên máy chủ (xem dongbo.js); DB là bản đang làm việc trên trình duyệt.
function normalizeData(data){
  const src = data || {};
  return {
    ...src,
    employees: Array.isArray(src.employees) ? src.employees : [],
    shiftTypes: Array.isArray(src.shiftTypes) ? src.shiftTypes : [],
    schedule: src.schedule && typeof src.schedule === 'object' ? src.schedule : {},
    orgParent: src.orgParent ?? 'Tên cơ quan chủ quản',
    orgName: src.orgName ?? 'Tên đơn vị'
  };
}

function saveData(){
  markDataChanged();
}

let DB = normalizeData({});

/* ===================== Date helpers ===================== */
function pad2(n){ return String(n).padStart(2,'0'); }
function daysInMonth(year, month){ return new Date(year, month+1, 0).getDate(); }
function dateStr(year, month, day){ return `${year}-${pad2(month+1)}-${pad2(day)}`; }
function weekdayOf(year, month, day){ return new Date(year, month, day).getDay(); }

function shiftHours(st){
  if(!st) return 0;
  let [sh,sm] = st.start.split(':').map(Number);
  let [eh,em] = st.end.split(':').map(Number);
  let startMin = sh*60+sm;
  let endMin = eh*60+em;
  let diff = endMin - startMin;
  if(diff <= 0) diff += 24*60;
  return diff/60;
}

function fmtHours(h){
  if(h === 0) return '0';
  return (Math.round(h*10)/10).toString();
}

function scheduleKey(empId, dStr){ return empId + '|' + dStr; }
function getShiftIdFor(empId, dStr){ return DB.schedule[scheduleKey(empId, dStr)] || null; }
function setShiftFor(empId, dStr, shiftTypeId){
  const key = scheduleKey(empId, dStr);
  if(shiftTypeId) DB.schedule[key] = shiftTypeId;
  else delete DB.schedule[key];
  saveData();
}
function findShiftType(id){ return DB.shiftTypes.find(s => s.id === id) || null; }
function findEmployee(id){ return DB.employees.find(e => e.id === id) || null; }

function getAllYearsInSchedule(empIdFilter){
  const years = new Set();
  for(const key in DB.schedule){
    const [empId, dStr] = key.split('|');
    if(empIdFilter && empIdFilter !== 'all' && empId !== empIdFilter) continue;
    years.add(Number(dStr.slice(0,4)));
  }
  years.add(new Date().getFullYear());
  return Array.from(years).sort((a,b)=>a-b);
}

/* ===================== App state ===================== */
let currentUser = null; // {role:'admin'} | {role:'viewer', employeeId}
let schedView = { year: new Date().getFullYear(), month: new Date().getMonth() };
let viewerView = { year: new Date().getFullYear(), month: new Date().getMonth() };
let trackState = { employeeId: 'all', mode: 'day', month: new Date().getMonth(), year: new Date().getFullYear() };
let viewerTrackState = { mode: 'day', year: new Date().getFullYear() };
let editingEmployeeId = null;
let editingShiftTypeId = null;
let assignCtx = null; // {empId, dStr}

/* ===================== Screen switching ===================== */
function showScreen(name){
  document.getElementById('screen-login').style.display = name === 'login' ? '' : 'none';
  document.getElementById('screen-admin').style.display = name === 'admin' ? '' : 'none';
  document.getElementById('screen-viewer').style.display = name === 'viewer' ? '' : 'none';
}

/* ===================== Modal helpers ===================== */
function openModal(id){ document.getElementById(id).style.display = 'flex'; }
function closeModal(id){ document.getElementById(id).style.display = 'none'; }

function confirmDialog(text, onOk){
  document.getElementById('modal-confirm-text').textContent = text;
  openModal('modal-confirm');
  const okBtn = document.getElementById('modal-confirm-ok');
  const cancelBtn = document.getElementById('modal-confirm-cancel');
  const cleanup = () => {
    okBtn.onclick = null; cancelBtn.onclick = null;
    closeModal('modal-confirm');
  };
  okBtn.onclick = () => { cleanup(); onOk(); };
  cancelBtn.onclick = () => { cleanup(); };
}

/* ===================== LOGIN ===================== */
function initLogin(){
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      document.getElementById('admin-login-error').textContent = '';
      document.getElementById('viewer-login-error').textContent = '';
    });
  });

  document.getElementById('btn-admin-login').addEventListener('click', e=>{
    const input = document.getElementById('admin-password-input');
    runLoginAction(e.currentTarget, 'admin-login-error', async ()=>{
      const result = await loginWith({role: 'admin', password: input.value});
      input.value = '';
      if(result.usingServerToken) showToast('Bạn đang đăng nhập bằng mã truy cập máy chủ. Hãy đặt mật khẩu quản trị tại mục Thiết lập.');
    });
  });
  document.getElementById('admin-password-input').addEventListener('keydown', e=>{
    if(e.key === 'Enter') document.getElementById('btn-admin-login').click();
  });

  document.getElementById('viewer-employee-select').addEventListener('change', renderViewerLoginPwState);

  document.getElementById('btn-viewer-login').addEventListener('click', e=>{
    const empId = document.getElementById('viewer-employee-select').value;
    const input = document.getElementById('viewer-password-input');
    runLoginAction(e.currentTarget, 'viewer-login-error', async ()=>{
      if(!empId) throw new Error('Vui lòng chọn nhân viên.');
      try{
        await loginWith({role: 'viewer', employeeId: empId, password: input.value});
        input.value = '';
      }catch(err){
        if(err.payload && err.payload.needsPassword) markPublicPassword(empId, false);
        throw err;
      }
    });
  });
  document.getElementById('viewer-password-input').addEventListener('keydown', e=>{
    if(e.key === 'Enter') document.getElementById('btn-viewer-login').click();
  });

  document.getElementById('btn-viewer-set-password').addEventListener('click', e=>{
    const empId = document.getElementById('viewer-employee-select').value;
    const codeInput = document.getElementById('viewer-join-code-input');
    const p1Input = document.getElementById('viewer-new-password-input');
    const p2Input = document.getElementById('viewer-new-password-confirm');
    runLoginAction(e.currentTarget, 'viewer-login-error', async ()=>{
      if(!empId) throw new Error('Vui lòng chọn nhân viên.');
      if(!codeInput.value.trim()) throw new Error('Vui lòng nhập mã đơn vị do quản trị thông báo.');
      if(p1Input.value.length < MIN_PASSWORD_LENGTH) throw new Error(`Mật khẩu cần ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`);
      if(p1Input.value !== p2Input.value) throw new Error('Mật khẩu nhập lại không khớp.');
      try{
        await createFirstPassword(empId, p1Input.value, codeInput.value);
        codeInput.value = '';
        p1Input.value = '';
        p2Input.value = '';
      }catch(err){
        if(err.status === 409) markPublicPassword(empId, true);
        throw err;
      }
    });
  });

  document.getElementById('btn-admin-logout').addEventListener('click', logout);
  document.getElementById('btn-viewer-logout').addEventListener('click', logout);
}

async function runLoginAction(button, errorId, action){
  const errEl = document.getElementById(errorId);
  errEl.textContent = '';
  button.disabled = true;
  try{
    await action();
  }catch(err){
    errEl.textContent = err.message;
  }finally{
    button.disabled = false;
  }
}

function markPublicPassword(empId, hasPassword){
  const emp = publicEmployee(empId);
  if(emp) emp.hasPassword = hasPassword;
  renderViewerLoginPwState();
}

function renderLoginViewerSelect(){
  const sel = document.getElementById('viewer-employee-select');
  const previous = sel.value;
  const emps = syncState.publicEmployees;
  sel.innerHTML = '';
  if(emps.length === 0){
    const opt = document.createElement('option');
    opt.textContent = 'Chưa có nhân viên nào';
    opt.value = '';
    sel.appendChild(opt);
    sel.disabled = true;
  } else {
    sel.disabled = false;
    emps.slice().sort((a,b)=>compareNames(a.name, b.name)).forEach(emp=>{
      const opt = document.createElement('option');
      opt.value = emp.id;
      opt.textContent = emp.name;
      sel.appendChild(opt);
    });
    if(emps.some(e => e.id === previous)) sel.value = previous;
  }
  renderViewerLoginPwState();
}

function renderViewerLoginPwState(){
  const sel = document.getElementById('viewer-employee-select');
  const emp = publicEmployee(sel.value);
  const existingDiv = document.getElementById('viewer-existing-pw');
  const newDiv = document.getElementById('viewer-new-pw');
  document.getElementById('viewer-login-error').textContent = '';
  if(!emp){
    existingDiv.style.display = 'none';
    newDiv.style.display = 'none';
    return;
  }
  if(emp.hasPassword){
    existingDiv.style.display = '';
    newDiv.style.display = 'none';
  } else {
    existingDiv.style.display = 'none';
    newDiv.style.display = '';
  }
}

/* ===================== ADMIN: entry & nav ===================== */
function enterAdmin(){
  showScreen('admin');
  renderOrgInfo();
  document.getElementById('settings-org-parent').value = DB.orgParent;
  document.getElementById('settings-org-name').value = DB.orgName;
  document.getElementById('settings-org-success').textContent = '';
  renderJoinCodeStatus();
  document.querySelectorAll('.nav-btn')[0].click();
  renderScheduleTable();
  renderEmployeesTable();
  renderShiftTypesTable();
  initTrackingSelectors();
  renderTrackingTable();
}

function renderJoinCodeStatus(){
  document.getElementById('join-code-status').textContent = syncState.joinCodeSet
    ? 'Đã thiết lập. Cán bộ chưa có mật khẩu nhập mã này để tạo mật khẩu lần đầu. Lưu mã mới sẽ thay mã cũ.'
    : 'Chưa thiết lập: cán bộ chưa có mật khẩu sẽ chưa tạo được mật khẩu. Hãy đặt mã rồi thông báo trong đơn vị.';
}

function initAdminNav(){
  document.querySelectorAll('.nav-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('#screen-admin .panel').forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.panel).classList.add('active');
      if(btn.dataset.panel === 'panel-tracking'){ initTrackingSelectors(); renderTrackingTable(); }
      if(btn.dataset.panel === 'panel-schedule'){ renderScheduleTable(); }
    });
  });
}

/* ===================== ADMIN: Lịch phân ca ===================== */
function initScheduleNav(){
  document.getElementById('sched-prev-month').addEventListener('click', ()=>{
    schedView.month--;
    if(schedView.month < 0){ schedView.month = 11; schedView.year--; }
    renderScheduleTable();
  });
  document.getElementById('sched-next-month').addEventListener('click', ()=>{
    schedView.month++;
    if(schedView.month > 11){ schedView.month = 0; schedView.year++; }
    renderScheduleTable();
  });
}

function renderScheduleTable(){
  document.getElementById('sched-month-label').textContent = `${MONTH_NAMES[schedView.month]} năm ${schedView.year}`;
  const table = document.getElementById('schedule-table');
  table.innerHTML = '';
  const nDays = daysInMonth(schedView.year, schedView.month);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const thName = document.createElement('th');
  thName.textContent = 'Nhân viên';
  headRow.appendChild(thName);
  for(let d=1; d<=nDays; d++){
    const th = document.createElement('th');
    const wd = weekdayOf(schedView.year, schedView.month, d);
    if(wd === 0 || wd === 6) th.classList.add('weekend');
    th.innerHTML = d + '<span class="wd">' + WEEKDAY_LABELS[wd] + '</span>';
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const emps = scheduleEmployees();
  if(emps.length === 0){
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = nDays + 1;
    td.textContent = DB.employees.length === 0
      ? 'Chưa có nhân viên. Hãy thêm nhân viên ở mục "Danh sách nhân viên".'
      : 'Không có nhân viên phù hợp với bộ lọc.';
    td.style.textAlign = 'center';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  emps.forEach(emp=>{
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.innerHTML = escapeHtml(emp.name) + (emp.unit ? `<span class="name-sub">${escapeHtml(emp.unit)}</span>` : '');
    tr.appendChild(tdName);
    for(let d=1; d<=nDays; d++){
      const dStr = dateStr(schedView.year, schedView.month, d);
      const td = document.createElement('td');
      td.className = 'cell-day';
      const wd = weekdayOf(schedView.year, schedView.month, d);
      if(wd === 0 || wd === 6) td.classList.add('weekend');
      const shiftId = getShiftIdFor(emp.id, dStr);
      const st = shiftId ? findShiftType(shiftId) : null;
      if(st){
        const chip = document.createElement('span');
        chip.className = 'shift-chip';
        chip.style.background = st.color;
        chip.textContent = shiftCode(st);
        chip.title = `${st.name} (${st.start}-${st.end})`;
        td.appendChild(chip);
      }
      td.addEventListener('click', ()=> openAssignModal(emp.id, dStr));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  document.getElementById('schedule-legend').innerHTML = DB.shiftTypes.map(st =>
    `<span class="legend-item"><span class="shift-chip" style="background:${safeColor(st.color)}">${escapeHtml(shiftCode(st))}</span>${escapeHtml(st.name)} (${escapeHtml(st.start)} - ${escapeHtml(st.end)})</span>`
  ).join('');
}

function scheduleEmployees(){
  const filter = document.getElementById('sched-role-filter').value;
  let emps = DB.employees.slice().sort((a,b)=>compareNames(a.name, b.name));
  if(filter === 'has'){
    const prefix = `${schedView.year}-${pad2(schedView.month+1)}`;
    const ids = new Set(Object.keys(DB.schedule).filter(k => k.split('|')[1].startsWith(prefix)).map(k => k.split('|')[0]));
    emps = emps.filter(e => ids.has(e.id));
  } else if(filter === 'none'){
    emps = emps.filter(e => !e.role);
  } else if(filter){
    emps = emps.filter(e => e.role === filter);
  }
  return emps;
}

function openAssignModal(empId, dStr){
  assignCtx = {empId, dStr};
  const emp = findEmployee(empId);
  document.getElementById('modal-assign-title').textContent = `${emp.name} — ${dStr}`;
  const list = document.getElementById('modal-assign-list');
  list.innerHTML = '';
  if(DB.shiftTypes.length === 0){
    list.innerHTML = '<p class="hint">Chưa có loại ca nào. Hãy thêm loại ca trước.</p>';
  }
  DB.shiftTypes.forEach(st=>{
    const item = document.createElement('div');
    item.className = 'shift-pick-item';
    item.innerHTML = `<span class="color-dot" style="background:${safeColor(st.color)}"></span>
      <span>${escapeHtml(st.name)} (${escapeHtml(st.start)} - ${escapeHtml(st.end)}, ${fmtHours(shiftHours(st))}h)</span>`;
    item.addEventListener('click', ()=>{
      setShiftFor(empId, dStr, st.id);
      closeModal('modal-assign');
      renderScheduleTable();
    });
    list.appendChild(item);
  });
  openModal('modal-assign');
}

document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('modal-assign-close').addEventListener('click', ()=> closeModal('modal-assign'));
  document.getElementById('modal-clear-shift').addEventListener('click', ()=>{
    if(assignCtx){
      setShiftFor(assignCtx.empId, assignCtx.dStr, null);
      closeModal('modal-assign');
      renderScheduleTable();
      renderViewerCalendar();
    }
  });
});

/* ===================== ADMIN: Nhân viên ===================== */
function fillSelect(sel, options, keepValue){
  const prev = keepValue ? sel.value : null;
  sel.innerHTML = options.map(([v, t]) => `<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`).join('');
  if(prev !== null && options.some(([v]) => v === prev)) sel.value = prev;
}

function initEmployeeFilters(){
  const roleOpts = DUTY_ROLES.map(r => [r.key, r.label]);
  fillSelect(document.getElementById('emp-role-filter'), [['', 'Tất cả'], ...roleOpts, ['none', 'Chưa phân vai trò']]);
  fillSelect(document.getElementById('emp-status-filter'), [['', 'Tất cả'], ...EMP_STATUSES.map(s => [s.key, s.label])]);
  fillSelect(document.getElementById('sched-role-filter'), [['', 'Tất cả nhân viên'], ['has', 'Người có lịch trong tháng'], ...roleOpts, ['none', 'Chưa phân vai trò']]);
  fillSelect(document.getElementById('employee-role-input'), [['', 'Không xếp trực tự động'], ...roleOpts]);
  fillSelect(document.getElementById('employee-status-input'), EMP_STATUSES.map(s => [s.key, s.label]));
  ['emp-search', 'emp-role-filter', 'emp-status-filter'].forEach(id => {
    document.getElementById(id).addEventListener(id === 'emp-search' ? 'input' : 'change', renderEmployeesTable);
  });
  document.getElementById('sched-role-filter').addEventListener('change', renderScheduleTable);
}

function filteredEmployees(){
  const q = document.getElementById('emp-search').value.trim().toLowerCase();
  const role = document.getElementById('emp-role-filter').value;
  const status = document.getElementById('emp-status-filter').value;
  return DB.employees.slice().sort((a,b)=>compareNames(a.name, b.name)).filter(e => {
    if(role === 'none' ? e.role : (role && e.role !== role)) return false;
    if(status && (e.status || 'active') !== status) return false;
    if(q && ![e.name, e.unit, e.phone, e.position, e.group].some(v => String(v || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderEmployeesTable(){
  const tbody = document.getElementById('employees-tbody');
  tbody.innerHTML = '';
  const emps = filteredEmployees();
  document.getElementById('emp-count').textContent = `${emps.length}/${DB.employees.length} nhân viên`;
  if(emps.length === 0){
    tbody.innerHTML = `<tr><td colspan="11">${DB.employees.length ? 'Không có nhân viên phù hợp với bộ lọc.' : 'Chưa có nhân viên nào.'}</td></tr>`;
    return;
  }
  emps.forEach(emp=>{
    const tr = document.createElement('tr');
    tr.dataset.emp = emp.id;
    const pwLabel = emp.hasPassword ? '<span class="pw-status set">Đã đặt mật khẩu</span>' : '<span class="pw-status">Chưa đặt</span>';
    tr.innerHTML = `
      ${INLINE_EMPLOYEE_COLUMNS.map(col => employeeCellHtml(emp, col)).join('')}
      <td>${pwLabel}</td>
      <td>
        <button class="icon-btn" data-act="edit">Sửa</button>
        <button class="icon-btn" data-act="resetpw">Đặt lại mật khẩu</button>
        <button class="icon-btn danger" data-act="delete">Xoá</button>
      </td>`;
    tr.querySelector('[data-act=edit]').addEventListener('click', ()=> openEmployeeModal(emp));
    tr.querySelector('[data-act=resetpw]').addEventListener('click', ()=>{
      confirmDialog(`Đặt lại mật khẩu của "${emp.name}"? Nhân viên sẽ cần tạo mật khẩu mới ở lần đăng nhập sau.`, async ()=>{
        try{
          await resetEmployeePassword(emp.id);
          renderEmployeesTable();
          showToast(`Đã đặt lại mật khẩu của "${emp.name}".`);
        }catch(err){
          showToast(err.message);
        }
      });
    });
    tr.querySelector('[data-act=delete]').addEventListener('click', ()=>{
      confirmDialog(`Xoá nhân viên "${emp.name}"? Lịch trực của nhân viên này cũng sẽ bị xoá.`, ()=>{
        DB.employees = DB.employees.filter(e=>e.id !== emp.id);
        Object.keys(DB.schedule).forEach(k=>{ if(k.startsWith(emp.id + '|')) delete DB.schedule[k]; });
        saveData();
        renderEmployeesTable();
        renderScheduleTable();
        initTrackingSelectors();
        renderTrackingTable();
      });
    });
    tbody.appendChild(tr);
  });
}

/* Sửa trực tiếp trên bảng: mỗi ô là một ô nhập, lưu khi Enter hoặc chuyển sang ô khác. */
const INLINE_EMPLOYEE_COLUMNS = [
  {field: 'name', label: 'Họ và tên'},
  {field: 'gender', label: 'Giới tính', options: () => [['', ''], ['Nam', 'Nam'], ['Nữ', 'Nữ']]},
  {field: 'birthYear', label: 'Năm sinh', attrs: 'inputmode="numeric" maxlength="4"'},
  {field: 'position', label: 'Chức danh'},
  {field: 'unit', label: 'Đơn vị'},
  {field: 'phone', label: 'Điện thoại'},
  {field: 'role', label: 'Vai trò trực', options: () => [['', 'Chưa phân vai trò'], ...DUTY_ROLES.map(r => [r.key, r.label])]},
  {field: 'group', label: 'Tổ'},
  {field: 'status', label: 'Tình trạng', options: () => EMP_STATUSES.map(s => [s.key, s.label])}
];

function employeeFieldValue(emp, field){
  if(field === 'status') return emp.status || 'active';
  return String(emp[field] ?? '');
}

function employeeFieldError(field, value){
  if(field === 'name' && !value) return 'Vui lòng nhập họ và tên nhân viên.';
  if(field === 'birthYear' && value && !/^\d{4}$/.test(value)) return 'Năm sinh gồm 4 chữ số.';
  return '';
}

function employeeCellHtml(emp, col){
  const value = employeeFieldValue(emp, col.field);
  const statusClass = col.field === 'status' ? ` status-select s-${escapeHtml(value)}` : '';
  const attrs = `class="cell-input cell-${col.field}${statusClass}" data-field="${col.field}" aria-label="${escapeHtml(col.label)}"`;
  if(!col.options){
    return `<td class="cell-edit"><input type="text" ${attrs} ${col.attrs || ''} spellcheck="false" value="${escapeHtml(value)}"></td>`;
  }
  const opts = col.options();
  // Giữ nguyên giá trị lạ (VD: dữ liệu nhập từ Excel) thay vì âm thầm đổi sang lựa chọn đầu tiên.
  if(!opts.some(([v]) => v === value)) opts.push([value, value]);
  const optionsHtml = opts.map(([v, t]) => `<option value="${escapeHtml(v)}"${v === value ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');
  return `<td class="cell-edit"><select ${attrs}>${optionsHtml}</select></td>`;
}

function employeeCellInput(empId, field){
  return document.querySelector(`#employees-tbody tr[data-emp="${CSS.escape(empId)}"] [data-field="${field}"]`);
}

function flashSavedCell(input){
  if(!input) return;
  input.classList.remove('cell-saved');
  void input.offsetWidth;
  input.classList.add('cell-saved');
}

function saveEmployeeCell(input){
  const emp = findEmployee(input.closest('tr').dataset.emp);
  if(!emp) return;
  const field = input.dataset.field;
  const value = input.value.trim();
  const error = employeeFieldError(field, value);
  if(error){
    input.value = input.defaultValue;
    showToast(error);
    return;
  }
  if(employeeFieldValue(emp, field) === value){
    input.value = value;
    return;
  }
  emp[field] = value;
  saveData();
  refreshEmployeeDependents();
  syncEmployeesTable(emp.id, field);
}

// Chỉ vẽ lại bảng khi thứ tự A-Z hoặc kết quả lọc thay đổi, để không làm mất ô đang chọn.
function syncEmployeesTable(empId, field){
  const shownIds = [...document.querySelectorAll('#employees-tbody tr[data-emp]')].map(tr => tr.dataset.emp).join('|');
  const expectedIds = filteredEmployees().map(e => e.id).join('|');
  if(shownIds === expectedIds){
    const input = employeeCellInput(empId, field);
    const emp = findEmployee(empId);
    if(input.tagName === 'INPUT') input.defaultValue = input.value = employeeFieldValue(emp, field);
    if(field === 'status'){
      [...input.classList].filter(c => c.startsWith('s-')).forEach(c => input.classList.remove(c));
      input.classList.add(`s-${input.value}`);
    }
    flashSavedCell(input);
    return;
  }
  // Chờ trình duyệt chuyển xong sang ô mới rồi mới vẽ lại và trả lại vị trí con trỏ.
  setTimeout(() => {
    const active = document.activeElement;
    const focusRow = active && active.matches('#employees-tbody .cell-input') ? active.closest('tr').dataset.emp : null;
    const focusField = focusRow ? active.dataset.field : null;
    renderEmployeesTable();
    if(focusRow){
      const next = employeeCellInput(focusRow, focusField);
      if(next) next.focus();
    }
    flashSavedCell(employeeCellInput(empId, field));
  }, 0);
}

function initEmployeeInlineEdit(){
  const tbody = document.getElementById('employees-tbody');
  tbody.addEventListener('change', e => {
    if(e.target.matches('.cell-input')) saveEmployeeCell(e.target);
  });
  tbody.addEventListener('keydown', e => {
    if(!e.target.matches('input.cell-input')) return;
    if(e.key === 'Enter'){
      e.preventDefault();
      e.target.blur();
    } else if(e.key === 'Escape'){
      e.target.value = e.target.defaultValue;
      e.target.blur();
    }
  });
}

function refreshEmployeeDependents(){
  renderScheduleTable();
  renderLoginViewerSelect();
  initTrackingSelectors();
  renderTrackingTable();
  renderAutoPanel();
}

const EMPLOYEE_FIELDS = [
  ['name', 'employee-name-input'], ['gender', 'employee-gender-input'], ['birthYear', 'employee-birth-input'],
  ['position', 'employee-position-input'], ['unit', 'employee-unit-input'], ['phone', 'employee-phone-input'],
  ['role', 'employee-role-input'], ['group', 'employee-group-input'], ['status', 'employee-status-input'],
  ['note', 'employee-note-input']
];

function openEmployeeModal(emp){
  editingEmployeeId = emp ? emp.id : null;
  document.getElementById('modal-employee-title').textContent = emp ? 'Sửa nhân viên' : 'Thêm nhân viên';
  EMPLOYEE_FIELDS.forEach(([field, id]) => {
    document.getElementById(id).value = emp ? (emp[field] || '') : '';
  });
  if(!emp) document.getElementById('employee-status-input').value = 'active';
  document.getElementById('employee-form-error').textContent = '';
  openModal('modal-employee');
}

function initEmployeeModal(){
  document.getElementById('btn-add-employee').addEventListener('click', ()=> openEmployeeModal(null));
  document.getElementById('employee-cancel-btn').addEventListener('click', ()=> closeModal('modal-employee'));
  document.getElementById('employee-save-btn').addEventListener('click', ()=>{
    const values = {};
    EMPLOYEE_FIELDS.forEach(([field, id]) => { values[field] = document.getElementById(id).value.trim(); });
    const errEl = document.getElementById('employee-form-error');
    const error = employeeFieldError('name', values.name) || employeeFieldError('birthYear', values.birthYear);
    if(error){ errEl.textContent = error; return; }
    if(editingEmployeeId){
      const target = findEmployee(editingEmployeeId);
      if(!target){ errEl.textContent = 'Nhân viên này vừa bị người khác xoá.'; return; }
      Object.assign(target, values);
    } else {
      DB.employees.push({id: uid('emp'), ...values, hasPassword: false});
    }
    saveData();
    closeModal('modal-employee');
    renderEmployeesTable();
    refreshEmployeeDependents();
  });
}

/* ===================== ADMIN: Loại ca ===================== */
function renderShiftTypesTable(){
  const tbody = document.getElementById('shifttypes-tbody');
  tbody.innerHTML = '';
  if(DB.shiftTypes.length === 0){
    tbody.innerHTML = '<tr><td colspan="6">Chưa có loại ca nào.</td></tr>';
    return;
  }
  DB.shiftTypes.forEach(st=>{
    const tr = document.createElement('tr');
    tr.title = isDutyShift(st.id) ? 'Loại ca dùng cho xếp lịch tự động' : '';
    tr.innerHTML = `
      <td><span class="shift-chip" style="background:${safeColor(st.color)}">${escapeHtml(shiftCode(st))}</span></td>
      <td>${escapeHtml(st.name)}</td>
      <td>${escapeHtml(st.start)}</td>
      <td>${escapeHtml(st.end)}</td>
      <td>${fmtHours(shiftHours(st))}</td>
      <td>
        <button class="icon-btn" data-act="edit">Sửa</button>
        <button class="icon-btn danger" data-act="delete">Xoá</button>
      </td>`;
    tr.querySelector('[data-act=edit]').addEventListener('click', ()=> openShiftTypeModal(st));
    tr.querySelector('[data-act=delete]').addEventListener('click', ()=>{
      confirmDialog(`Xoá loại ca "${st.name}"? Các ngày đã gán loại ca này sẽ bị bỏ trống.`, ()=>{
        DB.shiftTypes = DB.shiftTypes.filter(s=>s.id !== st.id);
        Object.keys(DB.schedule).forEach(k=>{ if(DB.schedule[k] === st.id) delete DB.schedule[k]; });
        saveData();
        renderShiftTypesTable();
        renderScheduleTable();
        renderTrackingTable();
      });
    });
    tbody.appendChild(tr);
  });
}

function openShiftTypeModal(st){
  editingShiftTypeId = st ? st.id : null;
  document.getElementById('modal-shifttype-title').textContent = st ? 'Sửa loại ca' : 'Thêm loại ca';
  document.getElementById('shifttype-name-input').value = st ? st.name : '';
  document.getElementById('shifttype-code-input').value = st ? (st.code || '') : '';
  document.getElementById('shifttype-start-input').value = st ? st.start : '06:00';
  document.getElementById('shifttype-end-input').value = st ? st.end : '14:00';
  document.getElementById('shifttype-color-input').value = st ? st.color : '#1f3864';
  document.getElementById('shifttype-form-error').textContent = '';
  openModal('modal-shifttype');
}

function initShiftTypeModal(){
  document.getElementById('btn-add-shifttype').addEventListener('click', ()=> openShiftTypeModal(null));
  document.getElementById('shifttype-cancel-btn').addEventListener('click', ()=> closeModal('modal-shifttype'));
  document.getElementById('shifttype-save-btn').addEventListener('click', ()=>{
    const name = document.getElementById('shifttype-name-input').value.trim();
    const code = document.getElementById('shifttype-code-input').value.trim().slice(0, 4);
    const start = document.getElementById('shifttype-start-input').value;
    const end = document.getElementById('shifttype-end-input').value;
    const color = document.getElementById('shifttype-color-input').value;
    const errEl = document.getElementById('shifttype-form-error');
    if(!name){ errEl.textContent = 'Vui lòng nhập tên ca.'; return; }
    if(!start || !end){ errEl.textContent = 'Vui lòng nhập đủ giờ bắt đầu/kết thúc.'; return; }
    if(editingShiftTypeId){
      const st = findShiftType(editingShiftTypeId);
      if(!st){ errEl.textContent = 'Loại ca này vừa bị người khác xoá.'; return; }
      st.name = name; st.code = code; st.start = start; st.end = end; st.color = color;
    } else {
      DB.shiftTypes.push({id: uid('st'), name, code, start, end, color});
    }
    saveData();
    closeModal('modal-shifttype');
    renderShiftTypesTable();
    renderScheduleTable();
    renderTrackingTable();
  });
}

/* ===================== ADMIN: Bảng theo dõi ===================== */
function initTrackingSelectors(){
  const empSel = document.getElementById('track-employee-select');
  const currentEmpVal = empSel.value || trackState.employeeId;
  empSel.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = 'all'; allOpt.textContent = 'Tất cả nhân viên';
  empSel.appendChild(allOpt);
  DB.employees.slice().sort((a,b)=>compareNames(a.name, b.name)).forEach(emp=>{
    const opt = document.createElement('option');
    opt.value = emp.id; opt.textContent = emp.name;
    empSel.appendChild(opt);
  });
  if([...empSel.options].some(o=>o.value === currentEmpVal)) empSel.value = currentEmpVal;
  trackState.employeeId = empSel.value;

  const monthSel = document.getElementById('track-month-select');
  if(monthSel.options.length === 0){
    MONTH_NAMES.forEach((name, idx)=>{
      const opt = document.createElement('option');
      opt.value = idx; opt.textContent = name;
      monthSel.appendChild(opt);
    });
  }
  monthSel.value = trackState.month;

  const yearSel = document.getElementById('track-year-select');
  const years = getAllYearsInSchedule(trackState.employeeId);
  yearSel.innerHTML = '';
  years.forEach(y=>{
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    yearSel.appendChild(opt);
  });
  if(!years.includes(trackState.year)) trackState.year = years[years.length-1];
  yearSel.value = trackState.year;

  updateTrackFieldVisibility();
}

function updateTrackFieldVisibility(){
  const mode = document.getElementById('track-mode-select').value;
  document.getElementById('track-month-field').style.display = mode === 'day' ? '' : 'none';
  document.getElementById('track-year-field').style.display = mode === 'year' ? 'none' : '';
}

function initTrackingEvents(){
  document.getElementById('track-employee-select').addEventListener('change', e=>{
    trackState.employeeId = e.target.value;
    const yearSel = document.getElementById('track-year-select');
    const years = getAllYearsInSchedule(trackState.employeeId);
    yearSel.innerHTML = '';
    years.forEach(y=>{
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
      yearSel.appendChild(opt);
    });
    if(!years.includes(trackState.year)) trackState.year = years[years.length-1];
    yearSel.value = trackState.year;
    renderTrackingTable();
  });
  document.getElementById('track-mode-select').addEventListener('change', e=>{
    trackState.mode = e.target.value;
    updateTrackFieldVisibility();
    renderTrackingTable();
  });
  document.getElementById('track-month-select').addEventListener('change', e=>{
    trackState.month = Number(e.target.value);
    renderTrackingTable();
  });
  document.getElementById('track-year-select').addEventListener('change', e=>{
    trackState.year = Number(e.target.value);
    renderTrackingTable();
  });
}

function renderTrackingTable(){
  const table = document.getElementById('tracking-table');
  table.innerHTML = '';
  const mode = trackState.mode;
  const empFilter = trackState.employeeId;

  if(mode === 'day') renderTrackDay(table, empFilter);
  else if(mode === 'month') renderTrackMonth(table, empFilter);
  else renderTrackYear(table, empFilter);
}

function renderTrackDay(table, empFilter){
  const year = trackState.year, month = trackState.month;
  const nDays = daysInMonth(year, month);

  if(empFilter !== 'all'){
    const emp = findEmployee(empFilter);
    table.innerHTML = `<thead><tr><th>Ngày</th><th>Ca trực</th><th>Giờ</th><th>Số giờ</th></tr></thead>`;
    const tbody = document.createElement('tbody');
    let total = 0;
    for(let d=1; d<=nDays; d++){
      const dStr = dateStr(year, month, d);
      const shiftId = emp ? getShiftIdFor(emp.id, dStr) : null;
      const st = shiftId ? findShiftType(shiftId) : null;
      const hrs = st ? shiftHours(st) : 0;
      total += hrs;
      const tr = document.createElement('tr');
      const wd = weekdayOf(year, month, d);
      tr.innerHTML = `<td>${d} (${WEEKDAY_LABELS[wd]})</td><td>${st ? escapeHtml(st.name) : '-'}</td><td>${st ? escapeHtml(st.start + ' - ' + st.end) : '-'}</td><td>${st ? fmtHours(hrs) : '-'}</td>`;
      tbody.appendChild(tr);
    }
    const trTotal = document.createElement('tr');
    trTotal.className = 'total-row';
    trTotal.innerHTML = `<td colspan="3">Tổng cộng</td><td>${fmtHours(total)}</td>`;
    tbody.appendChild(trTotal);
    table.appendChild(tbody);
  } else {
    const emps = DB.employees.slice().sort((a,b)=>compareNames(a.name, b.name));
    let head = '<thead><tr><th>Ngày</th>' + emps.map(e=>`<th>${escapeHtml(e.name)}</th>`).join('') + '<th>Tổng</th></tr></thead>';
    table.innerHTML = head;
    const tbody = document.createElement('tbody');
    const colTotals = emps.map(()=>0);
    let grandTotal = 0;
    for(let d=1; d<=nDays; d++){
      const dStr = dateStr(year, month, d);
      const wd = weekdayOf(year, month, d);
      let rowTotal = 0;
      const cells = emps.map((emp, idx)=>{
        const shiftId = getShiftIdFor(emp.id, dStr);
        const st = shiftId ? findShiftType(shiftId) : null;
        const hrs = st ? shiftHours(st) : 0;
        colTotals[idx] += hrs;
        rowTotal += hrs;
        return `<td>${st ? fmtHours(hrs) : '-'}</td>`;
      }).join('');
      grandTotal += rowTotal;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${d} (${WEEKDAY_LABELS[wd]})</td>${cells}<td>${fmtHours(rowTotal)}</td>`;
      tbody.appendChild(tr);
    }
    const trTotal = document.createElement('tr');
    trTotal.className = 'total-row';
    trTotal.innerHTML = `<td>Tổng cộng</td>${colTotals.map(t=>`<td>${fmtHours(t)}</td>`).join('')}<td>${fmtHours(grandTotal)}</td>`;
    tbody.appendChild(trTotal);
    table.appendChild(tbody);
  }
}

function renderTrackMonth(table, empFilter){
  const year = trackState.year;
  if(empFilter !== 'all'){
    const emp = findEmployee(empFilter);
    table.innerHTML = `<thead><tr><th>Tháng</th><th>Số ca</th><th>Tổng giờ</th></tr></thead>`;
    const tbody = document.createElement('tbody');
    let total = 0;
    for(let m=0; m<12; m++){
      const nDays = daysInMonth(year, m);
      let hrs = 0, count = 0;
      for(let d=1; d<=nDays; d++){
        const shiftId = emp ? getShiftIdFor(emp.id, dateStr(year, m, d)) : null;
        if(shiftId){ const st = findShiftType(shiftId); if(st){ hrs += shiftHours(st); count++; } }
      }
      total += hrs;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${MONTH_NAMES[m]}</td><td>${count}</td><td>${fmtHours(hrs)}</td>`;
      tbody.appendChild(tr);
    }
    const trTotal = document.createElement('tr');
    trTotal.className = 'total-row';
    trTotal.innerHTML = `<td colspan="2">Tổng cộng năm ${year}</td><td>${fmtHours(total)}</td>`;
    tbody.appendChild(trTotal);
    table.appendChild(tbody);
  } else {
    const emps = DB.employees.slice().sort((a,b)=>compareNames(a.name, b.name));
    table.innerHTML = '<thead><tr><th>Tháng</th>' + emps.map(e=>`<th>${escapeHtml(e.name)}</th>`).join('') + '<th>Tổng</th></tr></thead>';
    const tbody = document.createElement('tbody');
    const colTotals = emps.map(()=>0);
    let grandTotal = 0;
    for(let m=0; m<12; m++){
      const nDays = daysInMonth(year, m);
      let rowTotal = 0;
      const cells = emps.map((emp, idx)=>{
        let hrs = 0;
        for(let d=1; d<=nDays; d++){
          const shiftId = getShiftIdFor(emp.id, dateStr(year, m, d));
          if(shiftId){ const st = findShiftType(shiftId); if(st) hrs += shiftHours(st); }
        }
        colTotals[idx] += hrs;
        rowTotal += hrs;
        return `<td>${fmtHours(hrs)}</td>`;
      }).join('');
      grandTotal += rowTotal;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${MONTH_NAMES[m]}</td>${cells}<td>${fmtHours(rowTotal)}</td>`;
      tbody.appendChild(tr);
    }
    const trTotal = document.createElement('tr');
    trTotal.className = 'total-row';
    trTotal.innerHTML = `<td>Tổng cộng</td>${colTotals.map(t=>`<td>${fmtHours(t)}</td>`).join('')}<td>${fmtHours(grandTotal)}</td>`;
    tbody.appendChild(trTotal);
    table.appendChild(tbody);
  }
}

function renderTrackYear(table, empFilter){
  const years = getAllYearsInSchedule(empFilter);
  if(empFilter !== 'all'){
    const emp = findEmployee(empFilter);
    table.innerHTML = `<thead><tr><th>Năm</th><th>Số ca</th><th>Tổng giờ</th></tr></thead>`;
    const tbody = document.createElement('tbody');
    let total = 0;
    years.forEach(year=>{
      let hrs = 0, count = 0;
      for(let m=0; m<12; m++){
        const nDays = daysInMonth(year, m);
        for(let d=1; d<=nDays; d++){
          const shiftId = emp ? getShiftIdFor(emp.id, dateStr(year, m, d)) : null;
          if(shiftId){ const st = findShiftType(shiftId); if(st){ hrs += shiftHours(st); count++; } }
        }
      }
      total += hrs;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${year}</td><td>${count}</td><td>${fmtHours(hrs)}</td>`;
      tbody.appendChild(tr);
    });
    const trTotal = document.createElement('tr');
    trTotal.className = 'total-row';
    trTotal.innerHTML = `<td colspan="2">Tổng cộng</td><td>${fmtHours(total)}</td>`;
    tbody.appendChild(trTotal);
    table.appendChild(tbody);
  } else {
    const emps = DB.employees.slice().sort((a,b)=>compareNames(a.name, b.name));
    table.innerHTML = '<thead><tr><th>Năm</th>' + emps.map(e=>`<th>${escapeHtml(e.name)}</th>`).join('') + '<th>Tổng</th></tr></thead>';
    const tbody = document.createElement('tbody');
    const colTotals = emps.map(()=>0);
    let grandTotal = 0;
    years.forEach(year=>{
      let rowTotal = 0;
      const cells = emps.map((emp, idx)=>{
        let hrs = 0;
        for(let m=0; m<12; m++){
          const nDays = daysInMonth(year, m);
          for(let d=1; d<=nDays; d++){
            const shiftId = getShiftIdFor(emp.id, dateStr(year, m, d));
            if(shiftId){ const st = findShiftType(shiftId); if(st) hrs += shiftHours(st); }
          }
        }
        colTotals[idx] += hrs;
        rowTotal += hrs;
        return `<td>${fmtHours(hrs)}</td>`;
      }).join('');
      grandTotal += rowTotal;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${year}</td>${cells}<td>${fmtHours(rowTotal)}</td>`;
      tbody.appendChild(tr);
    });
    const trTotal = document.createElement('tr');
    trTotal.className = 'total-row';
    trTotal.innerHTML = `<td>Tổng cộng</td>${colTotals.map(t=>`<td>${fmtHours(t)}</td>`).join('')}<td>${fmtHours(grandTotal)}</td>`;
    tbody.appendChild(trTotal);
    table.appendChild(tbody);
  }
}

/* ===================== ADMIN: Cài đặt ===================== */
function initSettings(){
  document.getElementById('btn-save-org').addEventListener('click', ()=>{
    DB.orgParent = document.getElementById('settings-org-parent').value.trim();
    DB.orgName = document.getElementById('settings-org-name').value.trim();
    saveData();
    renderOrgInfo();
    document.getElementById('settings-org-success').textContent = 'Đã lưu thông tin đơn vị.';
  });

  document.getElementById('btn-change-admin-pw').addEventListener('click', async e=>{
    const button = e.currentTarget;
    const cur = document.getElementById('settings-current-pw').value;
    const p1 = document.getElementById('settings-new-pw').value;
    const p2 = document.getElementById('settings-confirm-pw').value;
    const errEl = document.getElementById('settings-error');
    const okEl = document.getElementById('settings-success');
    errEl.textContent = ''; okEl.textContent = '';
    if(p1.length < MIN_PASSWORD_LENGTH){ errEl.textContent = `Mật khẩu mới cần ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`; return; }
    if(p1 !== p2){ errEl.textContent = 'Mật khẩu nhập lại không khớp.'; return; }
    button.disabled = true;
    try{
      await changeAdminPassword(cur, p1);
      document.getElementById('settings-current-pw').value = '';
      document.getElementById('settings-new-pw').value = '';
      document.getElementById('settings-confirm-pw').value = '';
      okEl.textContent = 'Đổi mật khẩu thành công. Các máy khác đang đăng nhập quản trị sẽ phải đăng nhập lại.';
    }catch(err){
      errEl.textContent = err.message;
    }finally{
      button.disabled = false;
    }
  });

  document.getElementById('btn-save-join-code').addEventListener('click', async e=>{
    const button = e.currentTarget;
    const input = document.getElementById('settings-join-code');
    const errEl = document.getElementById('join-code-error');
    const okEl = document.getElementById('join-code-success');
    errEl.textContent = ''; okEl.textContent = '';
    if(input.value.trim().length < MIN_JOIN_CODE_LENGTH){ errEl.textContent = `Mã đơn vị cần ít nhất ${MIN_JOIN_CODE_LENGTH} ký tự.`; return; }
    button.disabled = true;
    try{
      await setJoinCode(input.value);
      input.value = '';
      okEl.textContent = 'Đã lưu mã đơn vị. Hãy thông báo mã này cho cán bộ trong đơn vị.';
      renderJoinCodeStatus();
    }catch(err){
      errEl.textContent = err.message;
    }finally{
      button.disabled = false;
    }
  });

  document.getElementById('btn-export-data').addEventListener('click', ()=>{
    const blob = new Blob([JSON.stringify(DB, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ca-truc-du-lieu.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  document.getElementById('import-file-input').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const parsed = JSON.parse(reader.result);
        if(!parsed.employees || !parsed.shiftTypes || !parsed.schedule){
          alert('File dữ liệu không hợp lệ.');
          return;
        }
        confirmDialog('Nhập dữ liệu sẽ thay thế toàn bộ dữ liệu hiện tại trên máy chủ, áp dụng cho mọi người dùng. Tiếp tục?', async ()=>{
          try{
            await replaceServerData({orgParent: '', orgName: '', ...parsed});
            alert('Nhập dữ liệu thành công. Cán bộ đã đặt mật khẩu ở bản cũ vẫn đăng nhập bằng mật khẩu cũ.');
          }catch(err){
            alert('Nhập dữ liệu không thành công: ' + err.message);
          }
        });
      }catch(err){
        alert('Không đọc được file JSON.');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });
}

/* ===================== VIEWER ===================== */
function enterViewer(){
  showScreen('viewer');
  const emp = findEmployee(currentUser.employeeId);
  document.getElementById('viewer-title').textContent = emp.name;
  renderOrgInfo();
  viewerView = { year: new Date().getFullYear(), month: new Date().getMonth() };
  viewerTrackState = { mode: 'day', year: new Date().getFullYear() };
  renderViewerCalendar();
  initViewerTrackingSelectors();
  renderViewerTrackingTable();
}

function initViewerNav(){
  document.getElementById('viewer-prev-month').addEventListener('click', ()=>{
    viewerView.month--;
    if(viewerView.month < 0){ viewerView.month = 11; viewerView.year--; }
    renderViewerCalendar();
    if(viewerTrackState.mode === 'day') renderViewerTrackingTable();
  });
  document.getElementById('viewer-next-month').addEventListener('click', ()=>{
    viewerView.month++;
    if(viewerView.month > 11){ viewerView.month = 0; viewerView.year++; }
    renderViewerCalendar();
    if(viewerTrackState.mode === 'day') renderViewerTrackingTable();
  });
}

function renderViewerCalendar(){
  if(!currentUser || currentUser.role !== 'viewer') return;
  const emp = findEmployee(currentUser.employeeId);
  if(!emp) return;
  document.getElementById('viewer-month-label').textContent = `${MONTH_NAMES[viewerView.month]} năm ${viewerView.year}`;
  const table = document.getElementById('viewer-calendar-table');
  const nDays = daysInMonth(viewerView.year, viewerView.month);
  table.innerHTML = '<thead><tr><th>Ngày</th><th>Thứ</th><th>Ca trực</th><th>Giờ</th><th>Số giờ</th></tr></thead>';
  const tbody = document.createElement('tbody');
  let total = 0;
  for(let d=1; d<=nDays; d++){
    const dStr = dateStr(viewerView.year, viewerView.month, d);
    const shiftId = getShiftIdFor(emp.id, dStr);
    const st = shiftId ? findShiftType(shiftId) : null;
    const hrs = st ? shiftHours(st) : 0;
    total += hrs;
    const wd = weekdayOf(viewerView.year, viewerView.month, d);
    const tr = document.createElement('tr');
    const shiftCell = st ? `<span class="shift-chip" style="background:${safeColor(st.color)}">${escapeHtml(st.name)}</span>` : '-';
    tr.innerHTML = `<td>${d}</td><td>${WEEKDAY_LABELS[wd]}</td><td>${shiftCell}</td><td>${st ? escapeHtml(st.start + ' - ' + st.end) : '-'}</td><td>${st ? fmtHours(hrs) : '-'}</td>`;
    tbody.appendChild(tr);
  }
  const trTotal = document.createElement('tr');
  trTotal.className = 'total-row';
  trTotal.innerHTML = `<td colspan="4">Tổng số giờ trong tháng</td><td>${fmtHours(total)}</td>`;
  tbody.appendChild(trTotal);
  table.appendChild(tbody);
  renderViewerRoster();
}

function initViewerTrackingSelectors(){
  const yearSel = document.getElementById('viewer-track-year-select');
  const years = getAllYearsInSchedule(currentUser.employeeId);
  yearSel.innerHTML = '';
  years.forEach(y=>{
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    yearSel.appendChild(opt);
  });
  if(!years.includes(viewerTrackState.year)) viewerTrackState.year = years[years.length-1];
  yearSel.value = viewerTrackState.year;
  updateViewerTrackFieldVisibility();
}

function updateViewerTrackFieldVisibility(){
  const mode = document.getElementById('viewer-track-mode-select').value;
  document.getElementById('viewer-track-year-field').style.display = (mode === 'month') ? '' : 'none';
}

function initViewerTrackingEvents(){
  document.getElementById('viewer-track-mode-select').addEventListener('change', e=>{
    viewerTrackState.mode = e.target.value;
    updateViewerTrackFieldVisibility();
    renderViewerTrackingTable();
  });
  document.getElementById('viewer-track-year-select').addEventListener('change', e=>{
    viewerTrackState.year = Number(e.target.value);
    renderViewerTrackingTable();
  });
}

function renderViewerTrackingTable(){
  const table = document.getElementById('viewer-tracking-table');
  table.innerHTML = '';
  const empId = currentUser.employeeId;
  const mode = viewerTrackState.mode;
  if(mode === 'day'){
    trackState.year = viewerView.year;
    trackState.month = viewerView.month;
    renderTrackDay(table, empId);
  } else if(mode === 'month'){
    trackState.year = viewerTrackState.year;
    renderTrackMonth(table, empId);
  } else {
    renderTrackYear(table, empId);
  }
}

/* ===================== Utility ===================== */
function shiftCode(st){
  if(st.code) return st.code;
  const words = st.name.trim().split(/\s+/).filter(w => w.toLowerCase() !== 'ca');
  return (words.length ? words : [st.name]).map(w => w[0]).join('').toUpperCase().slice(0,3) || '?';
}

function todayText(){
  const d = new Date();
  const wd = ['Chủ nhật','Thứ Hai','Thứ Ba','Thứ Tư','Thứ Năm','Thứ Sáu','Thứ Bảy'][d.getDay()];
  return `${wd}, ngày ${pad2(d.getDate())} tháng ${pad2(d.getMonth()+1)} năm ${d.getFullYear()}`;
}

function renderOrgInfo(){
  document.querySelectorAll('.org-parent').forEach(el => el.textContent = DB.orgParent);
  document.querySelectorAll('.org-name').forEach(el => el.textContent = DB.orgName);
  document.querySelectorAll('.today-label').forEach(el => el.textContent = todayText());
  document.title = DB.orgName ? `Lịch trực - ${DB.orgName}` : 'Hệ thống quản lý lịch trực';
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}
// Màu được chèn vào thuộc tính style, nên chỉ nhận mã #rrggbb.
function safeColor(c){ return /^#[0-9a-f]{6}$/i.test(c) ? c : '#1f3864'; }

/* ===================== Init ===================== */
document.addEventListener('DOMContentLoaded', ()=>{
  initLogin();
  initAdminNav();
  initScheduleNav();
  initEmployeeFilters();
  initEmployeeModal();
  initEmployeeInlineEdit();
  initShiftTypeModal();
  initTrackingEvents();
  initSettings();
  initViewerNav();
  initViewerTrackingEvents();

  renderOrgInfo();
  renderLoginViewerSelect();
  showScreen('login');
});
