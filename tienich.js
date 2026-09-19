/* ===================== TIỆN ÍCH (chỉ quản trị viên) ===================== */
const NAME_HEADERS = ['ho va ten', 'ho ten', 'ten nhan vien', 'nhan vien', 'can bo', 'ten can bo', 'ho va ten can bo'];
const SKIP_NAMES = ['thu', 'tong', 'tong cong', 'stt'];
const EMPTY_SHIFT = ['', '-', 'nghi', 'khong truc'];
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let pendingDelete = null;
let toastTimer = null;

/* ---------- Hàm dùng chung ---------- */
function fileExt(name){
  const m = String(name).toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : '';
}
function normText(v){
  return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function nameKey(v){ return String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase(); }
function cellText(v){ return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function round1(h){ return Math.round(h * 10) / 10; }
function fmtSize(b){
  if(b < 1024) return b + ' B';
  if(b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function fmtDateTime(iso){
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function fileImports(){
  if(!DB.fileImports) DB.fileImports = {};
  return DB.fileImports;
}
function sortedEmployees(){ return DB.employees.slice().sort((a, b) => compareNames(a.name, b.name)); }
function exportBaseName(){
  const d = new Date();
  return `du-lieu-lich-truc-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}
function refreshAdminViews(){
  renderEmployeesTable();
  renderShiftTypesTable();
  renderScheduleTable();
  initTrackingSelectors();
  renderTrackingTable();
  renderLoginViewerSelect();
  renderAutoPanel();
}
function showToast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* ---------- Lưu tệp về thư mục do người dùng chọn ---------- */
function downloadBlob(blob, name){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Hộp thoại chọn nơi lưu phải mở ngay khi bấm nút, trước mọi thao tác chờ mạng.
async function pickSaveTarget(suggestedName, mime, ext){
  if(!window.showSaveFilePicker) return {fallback: true};
  try{
    const opts = {suggestedName};
    if(ext){
      const type = (mime || '').split(';')[0].trim() || 'application/octet-stream';
      opts.types = [{description: 'Tệp ' + ext, accept: {[type]: [ext]}}];
    }
    return {handle: await window.showSaveFilePicker(opts)};
  }catch(err){
    if(err.name === 'AbortError') return null;
    return {fallback: true};
  }
}

async function writeToTarget(target, blob, name){
  if(target.handle){
    const writable = await target.handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return target.handle.name;
  }
  downloadBlob(blob, name);
  return name;
}

/* ---------- Kho lưu trữ Cloudflare R2 (cùng máy chủ, dùng phiên đăng nhập quản trị) ---------- */
function storageFetch(path, options = {}){
  return apiFetch('/api' + path, options);
}

async function testStorageConnection(){
  const status = document.getElementById('util-conn-status');
  status.className = 'hint';
  status.textContent = 'Đang kiểm tra kết nối...';
  try{
    const {files} = await (await storageFetch('/files')).json();
    status.className = 'success';
    status.textContent = `Kết nối thành công. Kho hiện có ${files.length} tệp.`;
    renderUtilityFiles();
  }catch(err){
    status.className = 'error';
    status.textContent = err.message;
  }
}

/* ---------- Đọc bảng dữ liệu từ tệp ---------- */
function sheetsFromWorkbook(wb){
  return wb.SheetNames.map(name => ({
    name,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[name], {header: 1, raw: true, defval: '', blankrows: true})
  }));
}

function sheetsFromHtml(html){
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('table')].filter(t => !t.parentElement.closest('table')).map((table, i) => {
    const label = [];
    let prev = table.previousElementSibling;
    while(prev && prev.tagName !== 'TABLE' && label.length < 3){
      label.unshift(prev.textContent);
      prev = prev.previousElementSibling;
    }
    const rows = [...table.rows].map(tr => [...tr.cells].map(td => cellText(td.textContent)));
    return {name: cellText(label.join(' ')).slice(0, 120) || `Bảng ${i + 1}`, rows};
  });
}

async function sheetsFromDocx(buffer){
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file('word/document.xml');
  if(!entry) throw new Error('Tệp Word không hợp lệ.');
  const xml = new DOMParser().parseFromString(await entry.async('string'), 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const body = xml.getElementsByTagNameNS(W, 'body')[0];
  if(!body) return [];
  const textOf = el => [...el.getElementsByTagNameNS(W, 't')].map(t => t.textContent).join('');
  const childrenNamed = (el, name) => [...el.children].filter(n => n.localName === name);
  const sheets = [];
  let recent = [];
  for(const node of body.children){
    if(node.localName === 'p'){
      const t = cellText(textOf(node));
      if(t){ recent.push(t); if(recent.length > 3) recent.shift(); }
    } else if(node.localName === 'tbl'){
      const rows = childrenNamed(node, 'tr').map(tr =>
        childrenNamed(tr, 'tc').map(tc => cellText(childrenNamed(tc, 'p').map(textOf).join(' '))));
      sheets.push({name: recent.join(' ').slice(0, 120) || `Bảng ${sheets.length + 1}`, rows});
      recent = [];
    }
  }
  return sheets;
}

// Trả về null nếu loại tệp không chứa bảng dữ liệu (chỉ lưu trữ).
async function extractSheets(blob, fileName){
  const ext = fileExt(fileName);
  if(['.xlsx', '.xls', '.ods'].includes(ext)){
    return sheetsFromWorkbook(XLSX.read(await blob.arrayBuffer(), {type: 'array'}));
  }
  if(ext === '.csv'){
    const text = (await blob.text()).replace(/^﻿/, '');
    return sheetsFromWorkbook(XLSX.read(text, {type: 'string', raw: true}));
  }
  if(['.doc', '.htm', '.html'].includes(ext)){
    const text = await blob.text();
    return /<table/i.test(text) ? sheetsFromHtml(text) : [];
  }
  if(ext === '.docx') return sheetsFromDocx(await blob.arrayBuffer());
  return null;
}

/* ---------- Nhận dạng cấu trúc bảng ---------- */
function findCol(header, names){
  return header.findIndex(c => names.includes(normText(c)));
}

function findPeriod(texts){
  for(const t of texts){
    const s = normText(t);
    const m = s.match(/thang\s*(\d{1,2})\s*(?:nam|\/|-|\.)\s*(\d{4})/) || s.match(/(?:^|[^a-z])t\s*(\d{1,2})\s*[-\/.]\s*(\d{4})/);
    if(m && +m[1] >= 1 && +m[1] <= 12) return {year: +m[2], month: +m[1] - 1};
  }
  return null;
}

function classifySheet(rows, sheetName, fileName){
  const limit = Math.min(rows.length, 15);
  for(let r = 0; r < limit; r++){
    const header = rows[r] || [];
    const shiftNameCol = findCol(header, ['ten ca', 'loai ca']);
    const startCol = findCol(header, ['gio bat dau', 'bat dau']);
    const endCol = findCol(header, ['gio ket thuc', 'ket thuc']);
    if(shiftNameCol >= 0 && startCol >= 0 && endCol >= 0){
      return {type: 'shifttypes', headerRow: r, shiftNameCol, startCol, endCol, colorCol: findCol(header, ['mau', 'mau ky hieu'])};
    }

    const nameCol = findCol(header, NAME_HEADERS);
    if(nameCol < 0) continue;

    const dayDutyCol = findCol(header, ['truc ngay']);
    const nightDutyCol = findCol(header, ['truc dem']);
    if(dayDutyCol >= 0 && nightDutyCol >= 0){
      // Ưu tiên dòng tiêu đề "LỊCH TRỰC ... THÁNG 09/2026" hơn dòng ngày ban hành.
      const above = rows.slice(0, r).flat().map(cellText).filter(Boolean);
      const period = findPeriod([...above.filter(t => normText(t).includes('lich')), sheetName, fileName, ...above]);
      return {
        type: 'roster', headerRow: r, nameCol, dayDutyCol, nightDutyCol, period,
        phoneCol: findCol(header, ['so dien thoai', 'dien thoai', 'sdt']),
        unitCol: findCol(header, ['don vi']),
        genderCol: findCol(header, ['gioi tinh']),
        birthCol: findCol(header, ['nam sinh']),
        titleCol: findCol(header, ['chuc danh', 'chuc vu'])
      };
    }

    const dayCols = {};
    header.forEach((c, i) => {
      if(i === nameCol) return;
      const m = String(c).trim().match(/^(\d{1,2})(?:\D|$)/);
      if(m && +m[1] >= 1 && +m[1] <= 31 && !(+m[1] in dayCols)) dayCols[+m[1]] = i;
    });
    if(Object.keys(dayCols).length >= 28){
      const period = findPeriod([sheetName, ...rows.slice(0, r).flat(), fileName]);
      return {type: 'grid', headerRow: r, nameCol, dayCols, period};
    }

    const positionCol = findCol(header, ['chuc vu', 'chuc danh']);
    const dateCol = findCol(header, ['ngay', 'ngay truc']);
    const shiftCol = findCol(header, ['ca', 'ca truc', 'loai ca', 'ten ca']);
    if(dateCol >= 0 && shiftCol >= 0) return {type: 'list', headerRow: r, nameCol, dateCol, shiftCol, positionCol};
    if(dateCol < 0){
      return {
        type: 'employees', headerRow: r, nameCol, positionCol,
        extraCols: {
          gender: findCol(header, ['gioi tinh']), birthYear: findCol(header, ['nam sinh']),
          unit: findCol(header, ['don vi']), phone: findCol(header, ['dien thoai', 'so dien thoai']),
          role: findCol(header, ['vai tro truc', 'vai tro']), group: findCol(header, ['to', 'to truc']),
          status: findCol(header, ['tinh trang']), note: findCol(header, ['ghi chu'])
        }
      };
    }
  }
  return {type: 'unknown'};
}

/* ---------- Chuyển đổi giá trị ô ---------- */
function validDate(y, mo, d){
  if(mo < 0 || mo > 11 || d < 1 || d > daysInMonth(y, mo)) return null;
  return dateStr(y, mo, d);
}

function parseDateCell(v){
  if(typeof v === 'number' && v > 0){
    const p = XLSX.SSF.parse_date_code(v);
    return p ? validDate(p.y, p.m - 1, p.d) : null;
  }
  const s = cellText(v);
  let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if(m) return validDate(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/);
  if(m) return validDate(+m[3], +m[2] - 1, +m[1]);
  return null;
}

function parseTimeCell(v){
  if(typeof v === 'number' && v >= 0 && v < 1){
    const mins = Math.round(v * 1440) % 1440;
    return pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60);
  }
  const m = cellText(v).match(/^(\d{1,2})\s*[:hH]\s*(\d{2})?/);
  if(m && +m[1] < 24 && +(m[2] || 0) < 60) return pad2(+m[1]) + ':' + pad2(+(m[2] || 0));
  return null;
}

function findShiftByCell(v){
  const s = normText(v);
  if(!s) return null;
  return DB.shiftTypes.find(st => normText(st.name) === s)
    || DB.shiftTypes.find(st => normText(shiftCode(st)) === s)
    || null;
}

function isPersonName(text){
  return !!text && text.length <= 80 && !text.includes(':') && !/^\d+$/.test(text) && !SKIP_NAMES.includes(normText(text));
}

function findOrCreateEmployee(name, position, ctx){
  let emp = DB.employees.find(e => nameKey(e.name) === nameKey(name));
  if(!emp){
    emp = {id: uid('emp'), name, position: position || '', hasPassword: false};
    DB.employees.push(emp);
    ctx.employeesAdded.push(emp.id);
  } else if(position && position !== (emp.position || '')){
    emp.position = position;
    ctx.employeesUpdated.add(emp.id);
  }
  return emp;
}

function applyShift(empId, dStr, shiftId, ctx){
  const key = scheduleKey(empId, dStr);
  const prev = DB.schedule[key] || null;
  const next = shiftId || null;
  if(prev === next) return;
  if(next) DB.schedule[key] = next; else delete DB.schedule[key];
  ctx.changes.push({key, prev, next});
  if(next) ctx.assigned++; else ctx.cleared++;
}

/* ---------- Cập nhật dữ liệu theo từng dạng bảng ---------- */
function importShiftTypes(sheet, ctx){
  const {rows, info} = sheet;
  for(let r = info.headerRow + 1; r < rows.length; r++){
    const row = rows[r];
    const name = cellText(row[info.shiftNameCol]);
    if(!name) continue;
    const start = parseTimeCell(row[info.startCol]);
    const end = parseTimeCell(row[info.endCol]);
    if(!start || !end){
      ctx.warnings.push(`"${sheet.name}", dòng ${r + 1}: giờ của ca "${name}" không hợp lệ.`);
      continue;
    }
    const colorRaw = info.colorCol >= 0 ? cellText(row[info.colorCol]) : '';
    const color = /^#[0-9a-f]{6}$/i.test(colorRaw) ? colorRaw : null;
    const st = DB.shiftTypes.find(x => normText(x.name) === normText(name));
    if(!st){
      DB.shiftTypes.push({id: uid('st'), name, start, end, color: color || '#1f3864'});
      ctx.shiftTypesAdded++;
    } else if(st.start !== start || st.end !== end || (color && st.color !== color)){
      st.start = start;
      st.end = end;
      if(color) st.color = color;
      ctx.shiftTypesUpdated++;
    }
  }
}

function importEmployees(sheet, ctx){
  const {rows, info} = sheet;
  for(let r = info.headerRow + 1; r < rows.length; r++){
    const name = cellText(rows[r][info.nameCol]);
    if(!isPersonName(name)) continue;
    const position = info.positionCol >= 0 ? cellText(rows[r][info.positionCol]) : '';
    const emp = findOrCreateEmployee(name, position, ctx);
    const extra = info.extraCols || {};
    Object.keys(extra).forEach(field => {
      if(extra[field] < 0) return;
      let value = cellText(rows[r][extra[field]]);
      if(field === 'role'){
        const s = normText(value);
        const role = DUTY_ROLES.find(x => normText(x.label) === s || x.key === s);
        value = role ? role.key : '';
      }
      if(field === 'status'){
        const s = normText(value);
        const st = EMP_STATUSES.find(x => normText(x.label) === s || x.key === s);
        if(!st) return;
        value = st.key;
      }
      if(value !== '' && emp[field] !== value){
        emp[field] = value;
        ctx.employeesUpdated.add(emp.id);
      }
    });
  }
}

function resolveShiftCell(value, unknown){
  const text = cellText(value);
  if(EMPTY_SHIFT.includes(normText(text))) return {shiftId: null};
  const st = findShiftByCell(text);
  if(!st){ unknown.add(text); return null; }
  return {shiftId: st.id};
}

function importList(sheet, ctx){
  const {rows, info} = sheet;
  const unknown = new Set();
  for(let r = info.headerRow + 1; r < rows.length; r++){
    const row = rows[r];
    const name = cellText(row[info.nameCol]);
    if(!isPersonName(name)) continue;
    const dStr = parseDateCell(row[info.dateCol]);
    if(!dStr){
      ctx.warnings.push(`"${sheet.name}", dòng ${r + 1}: ngày không hợp lệ.`);
      continue;
    }
    const resolved = resolveShiftCell(row[info.shiftCol], unknown);
    if(!resolved) continue;
    const position = info.positionCol >= 0 ? cellText(row[info.positionCol]) : '';
    const emp = findOrCreateEmployee(name, position, ctx);
    applyShift(emp.id, dStr, resolved.shiftId, ctx);
  }
  if(unknown.size) ctx.warnings.push(`"${sheet.name}": không tìm thấy loại ca ${[...unknown].map(x => `"${x}"`).join(', ')}.`);
}

function importGrid(sheet, ctx){
  const {rows, info} = sheet;
  if(!info.period){
    ctx.warnings.push(`"${sheet.name}": không xác định được tháng/năm (cần tên trang hoặc tiêu đề dạng "Tháng 9 năm 2026").`);
    return;
  }
  const {year, month} = info.period;
  const unknown = new Set();
  for(let r = info.headerRow + 1; r < rows.length; r++){
    const row = rows[r];
    const name = cellText(row[info.nameCol]);
    if(!isPersonName(name)) continue;
    const emp = findOrCreateEmployee(name, '', ctx);
    for(let d = 1; d <= daysInMonth(year, month); d++){
      const col = info.dayCols[d];
      // Ô trống giữ nguyên lịch cũ; muốn gỡ ca phải ghi "Nghỉ" hoặc "-".
      if(col === undefined || !cellText(row[col])) continue;
      const resolved = resolveShiftCell(row[col], unknown);
      if(resolved) applyShift(emp.id, dateStr(year, month, d), resolved.shiftId, ctx);
    }
  }
  if(unknown.size) ctx.warnings.push(`"${sheet.name}": không tìm thấy loại ca ${[...unknown].map(x => `"${x}"`).join(', ')}.`);
}

function importSheets(sheets, fileName){
  const ctx = {
    changes: [], assigned: 0, cleared: 0, employeesAdded: [], employeesUpdated: new Set(),
    shiftTypesAdded: 0, shiftTypesUpdated: 0, sheetsUsed: [], sheetsSkipped: [], warnings: []
  };
  const handlers = {shifttypes: importShiftTypes, employees: importEmployees, roster: importRoster, list: importList, grid: importGrid};
  const classified = sheets.map(s => ({...s, info: classifySheet(s.rows, s.name, fileName)}));
  ['shifttypes', 'employees', 'roster', 'list', 'grid'].forEach(type => {
    classified.filter(s => s.info.type === type).forEach(s => {
      handlers[type](s, ctx);
      ctx.sheetsUsed.push(s.name);
    });
  });
  classified.filter(s => s.info.type === 'unknown').forEach(s => ctx.sheetsSkipped.push(s.name));
  return ctx;
}

function makeRecord(name, ctx){
  return {
    name,
    processedAt: new Date().toISOString(),
    stats: ctx ? {
      assigned: ctx.assigned, cleared: ctx.cleared,
      employeesAdded: ctx.employeesAdded.length, employeesUpdated: ctx.employeesUpdated.size,
      shiftTypesAdded: ctx.shiftTypesAdded, shiftTypesUpdated: ctx.shiftTypesUpdated,
      sheetsUsed: ctx.sheetsUsed, sheetsSkipped: ctx.sheetsSkipped, warnings: ctx.warnings.slice(0, 30)
    } : null,
    changes: ctx ? ctx.changes : [],
    employeesAdded: ctx ? ctx.employeesAdded : []
  };
}

function revertImport(record){
  let reverted = 0, skipped = 0, removedEmployees = 0;
  for(let i = record.changes.length - 1; i >= 0; i--){
    const c = record.changes[i];
    if((DB.schedule[c.key] || null) !== c.next){ skipped++; continue; }
    if(c.prev) DB.schedule[c.key] = c.prev; else delete DB.schedule[c.key];
    reverted++;
  }
  record.employeesAdded.forEach(id => {
    const emp = findEmployee(id);
    if(!emp || emp.hasPassword) return;
    if(Object.keys(DB.schedule).some(k => k.startsWith(id + '|'))) return;
    DB.employees = DB.employees.filter(e => e.id !== id);
    removedEmployees++;
  });
  return {reverted, skipped, removedEmployees};
}

async function processFileData(key, blob, name){
  const sheets = await extractSheets(blob, name);
  const previous = fileImports()[key];
  if(previous) revertImport(previous);
  const record = makeRecord(name, sheets ? importSheets(sheets, name) : null);
  fileImports()[key] = record;
  saveData();
  refreshAdminViews();
  return record;
}

/* ---------- Báo cáo kết quả ---------- */
function hasImportedData(rec){ return rec && rec.stats && rec.stats.sheetsUsed.length > 0; }

function resultLines(rec){
  if(!hasImportedData(rec)) return ['Không có bảng dữ liệu phù hợp để cập nhật tự động; tệp được lưu trữ.'];
  const s = rec.stats;
  const lines = [
    `Lịch trực: phân công ${s.assigned} ca, gỡ ${s.cleared} ca.`,
    `Nhân viên: thêm mới ${s.employeesAdded}, cập nhật chức vụ ${s.employeesUpdated}.`,
    `Loại ca trực: thêm mới ${s.shiftTypesAdded}, cập nhật ${s.shiftTypesUpdated}.`,
    `Bảng đã xử lý: ${escapeHtml(s.sheetsUsed.join('; '))}.`
  ];
  if(s.sheetsSkipped.length) lines.push(`Bỏ qua (không phải bảng nhập liệu): ${escapeHtml(s.sheetsSkipped.join('; '))}.`);
  s.warnings.forEach(w => lines.push(`<span class="report-warn">${escapeHtml(w)}</span>`));
  return lines;
}

function resultSummary(rec){
  if(!rec) return 'Chưa xử lý';
  if(!hasImportedData(rec)) return 'Chỉ lưu trữ';
  const s = rec.stats;
  let text = `Phân công ${s.assigned} ca, gỡ ${s.cleared} ca; thêm ${s.employeesAdded} nhân viên`;
  if(s.warnings.length) text += `; ${s.warnings.length} cảnh báo`;
  return text;
}

function reportItemHtml(r){
  const lines = [];
  if(r.uploaded) lines.push('Đã lưu tệp lên kho lưu trữ Cloudflare R2.');
  if(r.error) lines.push(`<span class="report-warn">${escapeHtml(r.error)}</span>`);
  if(r.record) lines.push(...resultLines(r.record));
  if(r.extra) lines.push(...r.extra.map(escapeHtml));
  return `<div class="report-item${r.error ? ' error' : ''}">
    <div class="report-name">${escapeHtml(r.name)}</div>
    <ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>
  </div>`;
}

function showReport(reports, title){
  const now = new Date();
  document.getElementById('report-title').textContent = title;
  document.getElementById('report-body').innerHTML =
    `<p class="hint report-time">Hoàn thành lúc ${pad2(now.getHours())}:${pad2(now.getMinutes())} ngày ${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()}.</p>` +
    reports.map(reportItemHtml).join('');
  openModal('modal-report');
}

/* ---------- Quản lý tệp ---------- */
async function handleUtilityFiles(fileList){
  const files = [...fileList];
  if(!files.length) return;
  const progress = document.getElementById('util-progress');
  const reports = [];
  for(let i = 0; i < files.length; i++){
    const file = files[i];
    progress.textContent = `Đang xử lý tệp ${i + 1}/${files.length}: ${file.name}...`;
    const report = {name: file.name};
    try{
      const res = await storageFetch('/files', {
        method: 'POST',
        headers: {'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name)},
        body: file
      });
      const {key} = await res.json();
      report.uploaded = true;
      report.record = await processFileData(key, file, file.name);
    }catch(err){
      report.error = (report.uploaded ? 'Không đọc được nội dung tệp: ' : 'Không lưu được tệp lên kho: ') + err.message;
    }
    reports.push(report);
  }
  progress.textContent = '';
  showReport(reports, 'Hoàn thành xử lý tệp');
  renderUtilityFiles();
}

async function renderUtilityFiles(){
  const tbody = document.getElementById('util-files-tbody');
  tbody.innerHTML = '<tr><td colspan="5">Đang tải danh sách tệp...</td></tr>';
  let files;
  try{
    files = (await (await storageFetch('/files')).json()).files;
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="5">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  if(!files.length){
    tbody.innerHTML = '<tr><td colspan="5">Chưa có tệp nào.</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  files.forEach(f => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="file-name">${escapeHtml(f.name)}</td>
      <td>${fmtSize(f.size)}</td>
      <td>${fmtDateTime(f.uploaded)}</td>
      <td class="file-result">${escapeHtml(resultSummary(fileImports()[f.key]))}</td>
      <td>
        <button class="icon-btn" data-act="download">Lưu về máy</button>
        <button class="icon-btn" data-act="reprocess">Xử lý lại</button>
        <button class="icon-btn danger" data-act="delete">Xóa</button>
      </td>`;
    tr.querySelector('[data-act=download]').addEventListener('click', () => downloadStoredFile(f));
    tr.querySelector('[data-act=reprocess]').addEventListener('click', () => reprocessStoredFile(f));
    tr.querySelector('[data-act=delete]').addEventListener('click', () => askDeleteFile(f));
    tbody.appendChild(tr);
  });
}

async function fetchStoredBlob(f){
  return (await storageFetch('/files/' + encodeURIComponent(f.key))).blob();
}

async function downloadStoredFile(f){
  const target = await pickSaveTarget(f.name, f.contentType, fileExt(f.name));
  if(!target) return;
  try{
    const saved = await writeToTarget(target, await fetchStoredBlob(f), f.name);
    showToast(`Đã lưu tệp "${saved}".`);
  }catch(err){
    showReport([{name: f.name, error: err.message}], 'Lưu tệp không thành công');
  }
}

async function reprocessStoredFile(f){
  const progress = document.getElementById('util-progress');
  progress.textContent = `Đang xử lý lại tệp ${f.name}...`;
  try{
    const record = await processFileData(f.key, await fetchStoredBlob(f), f.name);
    showReport([{name: f.name, record}], 'Hoàn thành xử lý lại tệp');
  }catch(err){
    showReport([{name: f.name, error: err.message}], 'Xử lý lại không thành công');
  }
  progress.textContent = '';
  renderUtilityFiles();
}

function askDeleteFile(f){
  pendingDelete = f;
  const rec = fileImports()[f.key];
  const hasChanges = !!rec && (rec.changes.length > 0 || rec.employeesAdded.length > 0);
  document.getElementById('file-delete-text').textContent = hasChanges
    ? `Tệp "${f.name}" đã tạo ${rec.changes.length} thay đổi lịch trực và thêm ${rec.employeesAdded.length} nhân viên. Bạn có muốn hoàn tác các thay đổi này khi xóa tệp không?`
    : `Xóa tệp "${f.name}" khỏi kho lưu trữ?`;
  document.getElementById('file-delete-revert').hidden = !hasChanges;
  document.getElementById('file-delete-only').textContent = hasChanges ? 'Chỉ xóa tệp' : 'Xóa tệp';
  openModal('modal-file-delete');
}

async function deleteFile(revert){
  const f = pendingDelete;
  pendingDelete = null;
  closeModal('modal-file-delete');
  if(!f) return;
  try{
    await storageFetch('/files/' + encodeURIComponent(f.key), {method: 'DELETE'});
    const extra = ['Đã xóa tệp khỏi kho lưu trữ Cloudflare R2.'];
    const rec = fileImports()[f.key];
    if(rec && revert){
      const r = revertImport(rec);
      extra.push(`Đã hoàn tác ${r.reverted} thay đổi lịch trực và gỡ ${r.removedEmployees} nhân viên do tệp thêm vào.`);
      if(r.skipped) extra.push(`Giữ nguyên ${r.skipped} ô lịch trực đã được chỉnh sửa sau khi nhập tệp.`);
    }
    delete fileImports()[f.key];
    saveData();
    refreshAdminViews();
    showReport([{name: f.name, extra}], 'Hoàn thành xóa tệp');
  }catch(err){
    showReport([{name: f.name, error: err.message}], 'Xóa tệp không thành công');
  }
  renderUtilityFiles();
}

/* ---------- Xuất dữ liệu ---------- */
function hoursOf(empId, dStr){
  const st = findShiftType(getShiftIdFor(empId, dStr));
  return st ? shiftHours(st) : 0;
}

function periodsWithData(){
  const set = new Set(Object.keys(DB.schedule).map(k => k.split('|')[1].slice(0, 7)));
  const now = new Date();
  set.add(`${now.getFullYear()}-${pad2(now.getMonth() + 1)}`);
  return [...set].sort().map(s => ({year: +s.slice(0, 4), month: +s.slice(5, 7) - 1}));
}

function hoursTable(firstHeader, labels, hoursFn, emps){
  const totals = emps.map(() => 0);
  let grand = 0;
  const body = labels.map((label, idx) => {
    const hrs = emps.map(e => hoursFn(e, idx));
    const rowTotal = hrs.reduce((a, b) => a + b, 0);
    hrs.forEach((h, i) => { totals[i] += h; });
    grand += rowTotal;
    return [label, ...hrs.map(round1), round1(rowTotal)];
  });
  return [[firstHeader, ...emps.map(e => e.name), 'Tổng'], ...body, ['Tổng cộng', ...totals.map(round1), round1(grand)]];
}

function buildExportSections(){
  const emps = sortedEmployees();
  const periods = periodsWithData();
  const years = [...new Set(periods.map(p => p.year))];
  const allKeys = Object.keys(DB.schedule);
  const legend = 'Ký hiệu: ' + DB.shiftTypes.map(st => `${shiftCode(st)} - ${st.name} (${st.start}-${st.end})`).join('; ');
  const sections = [];

  sections.push({sheet: 'Thông tin chung', title: 'THÔNG TIN CHUNG', rows: [
    ['Nội dung', 'Thông tin'],
    ['Cơ quan chủ quản', DB.orgParent || ''],
    ['Đơn vị', DB.orgName || ''],
    ['Thời điểm xuất dữ liệu', todayText()],
    ['Số nhân viên', emps.length],
    ['Số loại ca trực', DB.shiftTypes.length],
    ['Tổng số ca đã phân công', allKeys.length],
    ['Tổng số giờ trực', round1(allKeys.reduce((sum, k) => sum + shiftHours(findShiftType(DB.schedule[k])), 0))]
  ]});

  sections.push({sheet: 'Nhân viên', title: 'DANH SÁCH NHÂN VIÊN', rows: [
    ['STT', 'Họ và tên', 'Giới tính', 'Năm sinh', 'Chức danh', 'Đơn vị', 'Điện thoại', 'Vai trò trực', 'Tổ', 'Tình trạng', 'Ghi chú', 'Mật khẩu tra cứu'],
    ...emps.map((e, i) => [i + 1, e.name, e.gender || '', e.birthYear || '', e.position || '', e.unit || '', e.phone || '',
      roleLabel(e.role), e.group || '', statusLabel(e.status), e.note || '', e.hasPassword ? 'Đã đặt' : 'Chưa đặt'])
  ]});

  sections.push({sheet: 'Loại ca', title: 'DANH MỤC LOẠI CA TRỰC', rows: [
    ['Ký hiệu', 'Tên ca', 'Giờ bắt đầu', 'Giờ kết thúc', 'Số giờ', 'Màu'],
    ...DB.shiftTypes.map(st => [shiftCode(st), st.name, st.start, st.end, round1(shiftHours(st)), st.color])
  ], cellStyle: (r, c) => r > 0 && c === 0
    ? `background:${safeColor(DB.shiftTypes[r - 1].color)};color:#fff;font-weight:bold;text-align:center` : ''});

  periods.forEach(({year, month}) => {
    const days = Array.from({length: daysInMonth(year, month)}, (_, i) => i + 1);
    sections.push({
      sheet: `Lịch T${pad2(month + 1)}-${year}`,
      title: `LỊCH PHÂN CÔNG TRỰC THÁNG ${month + 1} NĂM ${year}`,
      grid: true,
      headerRows: 2,
      note: legend,
      rows: [
        ['Họ và tên', ...days],
        ['Thứ', ...days.map(d => WEEKDAY_LABELS[weekdayOf(year, month, d)])],
        ...emps.map(e => [e.name, ...days.map(d => {
          const st = findShiftType(getShiftIdFor(e.id, dateStr(year, month, d)));
          return st ? shiftCode(st) : '';
        })])
      ],
      cellStyle: (r, c) => {
        if(c === 0) return '';
        const wd = weekdayOf(year, month, c);
        const weekend = wd === 0 || wd === 6;
        if(r < 2) return weekend ? 'background:#f3d6d6' : '';
        const st = findShiftType(getShiftIdFor(emps[r - 2].id, dateStr(year, month, c)));
        if(st) return `background:${safeColor(st.color)};color:#fff;font-weight:bold`;
        return weekend ? 'background:#fbf3e4' : '';
      }
    });
  });

  const detail = allKeys.map(k => {
    const [empId, dStr] = k.split('|');
    return {emp: findEmployee(empId), dStr, st: findShiftType(DB.schedule[k])};
  }).filter(x => x.emp && x.st)
    .sort((a, b) => a.dStr.localeCompare(b.dStr) || compareNames(a.emp.name, b.emp.name));
  sections.push({sheet: 'Chi tiết lịch trực', title: 'CHI TIẾT LỊCH TRỰC', rows: [
    ['STT', 'Họ và tên', 'Chức vụ', 'Ngày', 'Thứ', 'Ca trực', 'Giờ', 'Số giờ'],
    ...detail.map((x, i) => {
      const [y, m, d] = x.dStr.split('-').map(Number);
      return [i + 1, x.emp.name, x.emp.position || '', `${pad2(d)}/${pad2(m)}/${y}`,
        WEEKDAY_LABELS[weekdayOf(y, m - 1, d)], x.st.name, `${x.st.start} - ${x.st.end}`, round1(shiftHours(x.st))];
    })
  ]});

  periods.forEach(({year, month}) => {
    const n = daysInMonth(year, month);
    const labels = Array.from({length: n}, (_, i) => `${i + 1} (${WEEKDAY_LABELS[weekdayOf(year, month, i + 1)]})`);
    const rows = hoursTable('Ngày', labels, (e, idx) => hoursOf(e.id, dateStr(year, month, idx + 1)), emps);
    sections.push({
      sheet: `Theo dõi T${pad2(month + 1)}-${year}`,
      title: `BẢNG THEO DÕI THỜI GIAN TRỰC THEO NGÀY - THÁNG ${month + 1} NĂM ${year}`,
      boldFrom: rows.length - 1, rows
    });
  });

  years.forEach(year => {
    const monthHours = (e, m) => {
      let h = 0;
      for(let d = 1; d <= daysInMonth(year, m); d++) h += hoursOf(e.id, dateStr(year, m, d));
      return h;
    };
    const rows = hoursTable('Tháng', MONTH_NAMES, monthHours, emps);
    const shiftCounts = emps.map(e => allKeys.filter(k => k.startsWith(`${e.id}|${year}-`) && findShiftType(DB.schedule[k])).length);
    rows.push(['Số ca trong năm', ...shiftCounts, shiftCounts.reduce((a, b) => a + b, 0)]);
    sections.push({
      sheet: `Tổng hợp năm ${year}`,
      title: `BẢNG TỔNG HỢP THỜI GIAN TRỰC THEO THÁNG - NĂM ${year}`,
      boldFrom: rows.length - 2, rows
    });
  });

  const yearHours = (e, idx) => {
    const y = years[idx];
    return allKeys.filter(k => k.startsWith(`${e.id}|${y}-`)).reduce((sum, k) => sum + shiftHours(findShiftType(DB.schedule[k])), 0);
  };
  const yearRows = hoursTable('Năm', years.map(String), yearHours, emps);
  sections.push({sheet: 'Tổng hợp theo năm', title: 'BẢNG TỔNG HỢP THỜI GIAN TRỰC THEO NĂM', boldFrom: yearRows.length - 1, rows: yearRows});

  return sections;
}

function buildExcelBlob(sections){
  const wb = XLSX.utils.book_new();
  const used = new Set();
  const orgLine = [DB.orgParent, DB.orgName].filter(Boolean).join(' - ').toUpperCase();
  sections.forEach(sec => {
    const aoa = [[orgLine], [sec.title], [], ...sec.rows];
    if(sec.note) aoa.push([], [sec.note]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const width = Math.max(...sec.rows.map(r => r.length));
    ws['!cols'] = Array.from({length: width}, (_, c) => ({wch: c === 0 ? 28 : (sec.grid ? 5 : 16)}));
    let name = sec.sheet.slice(0, 31);
    for(let i = 2; used.has(name); i++) name = `${sec.sheet.slice(0, 26)} (${i})`;
    used.add(name);
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  return new Blob([XLSX.write(wb, {bookType: 'xlsx', type: 'array'})], {type: XLSX_MIME});
}

function sectionTableHtml(sec){
  const headerRows = sec.headerRows || 1;
  const cell = (tag, value, r, c) => {
    const style = sec.cellStyle ? sec.cellStyle(r, c) : '';
    return `<${tag}${style ? ` style="${style}"` : ''}>${escapeHtml(value)}</${tag}>`;
  };
  const head = sec.rows.slice(0, headerRows)
    .map((row, r) => `<tr>${row.map((v, c) => cell('th', v, r, c)).join('')}</tr>`).join('');
  const body = sec.rows.slice(headerRows).map((row, i) => {
    const r = i + headerRows;
    const bold = sec.boldFrom !== undefined && r >= sec.boldFrom;
    return `<tr${bold ? ' class="total"' : ''}>${row.map((v, c) => cell('td', v, r, c)).join('')}</tr>`;
  }).join('');
  return `<table class="data${sec.grid ? ' grid' : ''}"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function buildDocumentHtml(sections, mode, title){
  const css = `
body{font-family:"Times New Roman",Times,serif;font-size:12pt;color:#000}
table.doc-head{width:100%;border-collapse:collapse;margin-bottom:10pt}
table.doc-head td{width:50%;text-align:center;vertical-align:top;border:none;padding:0}
table.doc-head p{margin:0 0 2pt}
.b{font-weight:bold}.u{text-decoration:underline}.i{font-style:italic;margin-top:6pt}
h1{text-align:center;font-size:15pt;color:#a31d1d;margin:14pt 0 6pt}
h2{font-size:12pt;color:#1f3864;margin:16pt 0 6pt;page-break-after:avoid}
table.data{border-collapse:collapse;width:100%;margin-bottom:4pt}
table.data th,table.data td{border:1px solid #555;padding:3pt 5pt;font-size:10pt;text-align:left;vertical-align:middle}
table.data th{background:#d9e1f2;font-weight:bold}
table.grid th,table.grid td{font-size:8pt;padding:2pt 1pt;text-align:center}
table.grid th:first-child,table.grid td:first-child{text-align:left;padding:2pt 4pt;white-space:nowrap}
tr.total td{font-weight:bold;background:#e3e9f2}
.note{font-size:9.5pt;font-style:italic;margin:2pt 0 0}
thead{display:table-header-group}
tr{page-break-inside:avoid}`;

  const inner = `
<table class="doc-head"><tr>
  <td><p>${escapeHtml((DB.orgParent || '').toUpperCase())}</p><p class="b">${escapeHtml((DB.orgName || '').toUpperCase())}</p></td>
  <td><p class="b">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</p><p class="b u">Độc lập - Tự do - Hạnh phúc</p><p class="i">${escapeHtml(todayText())}</p></td>
</tr></table>
<h1>DỮ LIỆU HỆ THỐNG QUẢN LÝ LỊCH TRỰC</h1>
${sections.map(sec => `<h2>${escapeHtml(sec.title)}</h2>\n${sectionTableHtml(sec)}${sec.note ? `<p class="note">${escapeHtml(sec.note)}</p>` : ''}`).join('\n')}`;

  if(mode === 'doc'){
    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>@page WordSection1{size:841.9pt 595.3pt;mso-page-orientation:landscape;margin:42pt 36pt 42pt 42pt}div.WordSection1{page:WordSection1}${css}</style>
</head><body><div class="WordSection1">${inner}</div></body></html>`;
  }
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>@page{size:A4 landscape;margin:12mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}${css}</style>
</head><body>${inner}</body></html>`;
}

function exportPdf(sections, title){
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  frame.srcdoc = buildDocumentHtml(sections, 'pdf', title);
  frame.onload = () => {
    const originalTitle = document.title;
    document.title = title;
    frame.contentWindow.focus();
    frame.contentWindow.print();
    document.title = originalTitle;
    setTimeout(() => frame.remove(), 1000);
  };
  document.body.appendChild(frame);
}

function openExportModal(){
  document.querySelectorAll('input[name="export-format"]').forEach(input => { input.checked = false; });
  document.getElementById('export-error').textContent = '';
  openModal('modal-export');
}

async function confirmExport(){
  const chosen = document.querySelector('input[name="export-format"]:checked');
  if(!chosen){
    document.getElementById('export-error').textContent = 'Vui lòng chọn định dạng tệp muốn xuất.';
    return;
  }
  closeModal('modal-export');
  const base = exportBaseName();
  if(chosen.value === 'pdf'){
    exportPdf(buildExportSections(), base);
    return;
  }
  const isExcel = chosen.value === 'xlsx';
  const name = base + (isExcel ? '.xlsx' : '.doc');
  const target = await pickSaveTarget(name, isExcel ? XLSX_MIME : 'application/msword', isExcel ? '.xlsx' : '.doc');
  if(!target) return;
  const sections = buildExportSections();
  const blob = isExcel
    ? buildExcelBlob(sections)
    : new Blob(['﻿', buildDocumentHtml(sections, 'doc', base)], {type: 'application/msword'});
  const saved = await writeToTarget(target, blob, name);
  showToast(`Đã xuất dữ liệu ra tệp "${saved}".`);
}

async function downloadTemplate(){
  const fileName = 'tep-mau-lich-truc.xlsx';
  const target = await pickSaveTarget(fileName, XLSX_MIME, '.xlsx');
  if(!target) return;

  const now = new Date();
  const year = now.getFullYear(), month = now.getMonth();
  const days = Array.from({length: daysInMonth(year, month)}, (_, i) => i + 1);
  const emps = sortedEmployees();
  const names = emps.length ? emps.map(e => e.name) : ['Nguyễn Văn A', 'Trần Thị B'];
  const firstShift = DB.shiftTypes[0] ? DB.shiftTypes[0].name : 'Ca sáng';

  const wb = XLSX.utils.book_new();
  const addSheet = (sheetName, aoa, cols) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = cols;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  };
  addSheet('Hướng dẫn', [
    ['HƯỚNG DẪN SỬ DỤNG TỆP MẪU'], [],
    ['1. Giữ nguyên dòng tiêu đề cột của từng trang; có thể xóa trang không dùng tới.'],
    ['2. Trang "Loại ca": khai báo tên ca, giờ bắt đầu, giờ kết thúc (định dạng 06:00).'],
    ['3. Trang "Nhân viên": họ và tên, chức vụ.'],
    ['4. Trang "Lịch phân công": mỗi dòng là một ca trực, ngày ghi dạng ngày/tháng/năm. Để trống cột Ca trực hoặc ghi "Nghỉ" để gỡ ca.'],
    ['5. Trang lịch tháng: tên trang dạng "Lịch T09-2026"; ghi ký hiệu hoặc tên ca vào ô ngày, ghi "Nghỉ" để gỡ ca, ô trống giữ nguyên.'],
    ['6. Tải tệp vào mục Tiện ích; hệ thống tự động cập nhật và báo kết quả khi hoàn thành.']
  ], [{wch: 120}]);
  addSheet('Loại ca', [
    ['Ký hiệu', 'Tên ca', 'Giờ bắt đầu', 'Giờ kết thúc', 'Màu'],
    ...DB.shiftTypes.map(st => [shiftCode(st), st.name, st.start, st.end, st.color])
  ], [{wch: 10}, {wch: 22}, {wch: 14}, {wch: 14}, {wch: 12}]);
  addSheet('Nhân viên', [
    ['STT', 'Họ và tên', 'Giới tính', 'Năm sinh', 'Chức danh', 'Đơn vị', 'Điện thoại', 'Vai trò trực', 'Tổ', 'Tình trạng'],
    ...names.map((n, i) => {
      const e = emps[i] || {};
      return [i + 1, n, e.gender || '', e.birthYear || '', e.position || '', e.unit || '', e.phone || '',
        roleLabel(e.role), e.group || '', statusLabel(e.status)];
    })
  ], [{wch: 6}, {wch: 28}, {wch: 10}, {wch: 10}, {wch: 18}, {wch: 16}, {wch: 16}, {wch: 16}, {wch: 10}, {wch: 22}]);
  addSheet('Lịch phân công', [
    ['STT', 'Họ và tên', 'Ngày', 'Ca trực'],
    ...names.slice(0, 2).map((n, i) => [i + 1, n, `${pad2(i + 1)}/${pad2(month + 1)}/${year}`, firstShift])
  ], [{wch: 6}, {wch: 28}, {wch: 14}, {wch: 18}]);
  addSheet(`Lịch T${pad2(month + 1)}-${year}`, [
    [`LỊCH PHÂN CÔNG TRỰC THÁNG ${month + 1} NĂM ${year}`], [],
    ['Họ và tên', ...days],
    ...names.map(n => [n, ...days.map(() => '')])
  ], [{wch: 28}, ...days.map(() => ({wch: 5}))]);

  const saved = await writeToTarget(target, new Blob([XLSX.write(wb, {bookType: 'xlsx', type: 'array'})], {type: XLSX_MIME}), fileName);
  showToast(`Đã lưu tệp mẫu "${saved}".`);
}

/* ---------- Khởi tạo ---------- */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('[data-panel="panel-utility"]').addEventListener('click', () => {
    document.getElementById('util-conn-status').textContent = '';
    renderUtilityFiles();
  });

  document.getElementById('util-test-conn').addEventListener('click', testStorageConnection);
  document.getElementById('util-export-btn').addEventListener('click', openExportModal);
  document.getElementById('util-template-btn').addEventListener('click', downloadTemplate);
  document.getElementById('util-refresh-btn').addEventListener('click', renderUtilityFiles);
  document.getElementById('export-confirm-btn').addEventListener('click', confirmExport);
  document.getElementById('export-cancel-btn').addEventListener('click', () => closeModal('modal-export'));
  document.getElementById('report-close-btn').addEventListener('click', () => closeModal('modal-report'));
  document.getElementById('file-delete-revert').addEventListener('click', () => deleteFile(true));
  document.getElementById('file-delete-only').addEventListener('click', () => deleteFile(false));
  document.getElementById('file-delete-cancel').addEventListener('click', () => {
    pendingDelete = null;
    closeModal('modal-file-delete');
  });

  const input = document.getElementById('util-file-input');
  input.addEventListener('change', () => {
    handleUtilityFiles(input.files);
    input.value = '';
  });

  const zone = document.getElementById('util-dropzone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag');
    handleUtilityFiles(e.dataTransfer.files);
  });
  // Chặn trình duyệt mở tệp khi thả nhầm ra ngoài vùng kéo thả.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
});
