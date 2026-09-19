/* ===================== XẾP LỊCH TRỰC TỰ ĐỘNG ===================== */
const DUTY_KINDS = {day: 'Trực ngày', night: 'Trực đêm', full: 'Trực ngày và đêm'};
const DUTY_KIND_DEFAULTS = {
  day: {code: 'N', start: '07:30', end: '17:00', color: '#1f5fa8'},
  night: {code: 'Đ', start: '17:00', end: '07:30', color: '#4b2e83'},
  full: {code: 'NĐ', start: '07:30', end: '07:30', color: '#a31d1d'}
};
const FIXED_HOLIDAYS = ['01-01', '04-30', '05-01', '09-01', '09-02'];
const WEEKDAY_FULL = ['CHỦ NHẬT', 'THỨ HAI', 'THỨ BA', 'THỨ TƯ', 'THỨ NĂM', 'THỨ SÁU', 'THỨ BẢY'];
const ROLE_SHORT = {lanhdao: 'LĐ', truongca: 'TC', ksv: 'KSV', vanthu: 'VT', laixe: 'LX'};
// Người thuộc các vai trò này, đang tham gia trực mà không có lịch trong tháng, được liệt kê là nghỉ trực luân phiên.
const ROTATION_ROLES = ['truongca', 'ksv'];

let autoView = {year: new Date().getFullYear(), month: new Date().getMonth()};
let autoTab = 'roster';
let lastImportedPeriod = null;

/* ---------- Cấu hình ---------- */
function defaultDutyConfig(){
  return {
    shiftIds: {},
    roles: {
      lanhdao: {normal: {day: 0, night: 1}, rest: {day: 1, night: 1, same: true}, mode: 'day', unit: 'person'},
      truongca: {normal: {day: 0, night: 1}, rest: {day: 1, night: 1, same: false}, mode: 'day', unit: 'person'},
      ksv: {normal: {day: 0, night: 2}, rest: {day: 2, night: 2, same: false}, mode: 'day', unit: 'person'},
      vanthu: {normal: {day: 0, night: 1}, rest: {day: 1, night: 1, same: true}, mode: 'week', unit: 'person'},
      laixe: {normal: {day: 0, night: 1}, rest: {day: 1, night: 1, same: true}, mode: 'day', unit: 'group'}
    },
    rules: {sameDay: true, gap: true, gapDays: 3, weekend: true, unit: true, replace: true},
    holidays: {},
    doc: {
      title: 'LỊCH TRỰC NGHIỆP VỤ THÁNG {MM}/{YYYY}',
      place: 'Hà Nội',
      info: '',
      recipients: 'Lãnh đạo;\nCác phòng nghiệp vụ;\nLưu.',
      signTitle: 'TL. THỦ TRƯỞNG ĐƠN VỊ',
      signer: ''
    },
    lastRun: null
  };
}

function ensureDutySetup(){
  const def = defaultDutyConfig();
  if(!DB.dutyConfig) DB.dutyConfig = def;
  const cfg = DB.dutyConfig;
  Object.keys(def).forEach(k => { if(cfg[k] === undefined) cfg[k] = def[k]; });
  DUTY_ROLES.forEach(r => { if(!cfg.roles[r.key]) cfg.roles[r.key] = def.roles[r.key]; });
  Object.keys(def.rules).forEach(k => { if(cfg.rules[k] === undefined) cfg.rules[k] = def.rules[k]; });
  Object.keys(def.doc).forEach(k => { if(cfg.doc[k] === undefined) cfg.doc[k] = def.doc[k]; });
  Object.keys(DUTY_KINDS).forEach(dutyShiftId);
}

// Loại ca dùng cho xếp lịch; tạo lại nếu đã bị xóa.
function dutyShiftId(kind){
  const cfg = DB.dutyConfig;
  let st = findShiftType(cfg.shiftIds[kind]) || DB.shiftTypes.find(s => normText(s.name) === normText(DUTY_KINDS[kind]));
  if(!st){
    st = {id: uid('st'), name: DUTY_KINDS[kind], ...DUTY_KIND_DEFAULTS[kind]};
    DB.shiftTypes.push(st);
  }
  cfg.shiftIds[kind] = st.id;
  return st.id;
}

function isDutyShift(id){ return !!DB.dutyConfig && Object.values(DB.dutyConfig.shiftIds).includes(id); }

function dutyKindOf(shiftId){
  if(!shiftId) return null;
  const ids = DB.dutyConfig.shiftIds;
  if(shiftId === ids.full) return 'full';
  if(shiftId === ids.day) return 'day';
  if(shiftId === ids.night) return 'night';
  const st = findShiftType(shiftId);
  if(!st) return null;
  if(shiftHours(st) >= 20) return 'full';
  const h = +st.start.slice(0, 2);
  return h >= 5 && h < 17 ? 'day' : 'night';
}

/* ---------- Ngày tháng ---------- */
function ordOf(y, m, d){ return Math.round(Date.UTC(y, m, d) / 86400000); }
function dateOfOrd(ord){
  const t = new Date(ord * 86400000);
  return {y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate()};
}
function strOfOrd(ord){ const x = dateOfOrd(ord); return dateStr(x.y, x.m, x.d); }
function ordOfStr(s){ return ordOf(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
function fmtOrd(ord){ const x = dateOfOrd(ord); return `${pad2(x.d)}/${pad2(x.m + 1)}`; }
function weekdayOfOrd(ord){ return (ord + 4) % 7; }
function monthKey(y, m){ return `${y}-${pad2(m + 1)}`; }
function shiftMonth(y, m, delta){
  const t = new Date(y, m + delta, 1);
  return {year: t.getFullYear(), month: t.getMonth()};
}

function holidaysOf(y, m){
  const saved = DB.dutyConfig.holidays[monthKey(y, m)];
  if(Array.isArray(saved)) return saved;
  return FIXED_HOLIDAYS.filter(md => +md.slice(0, 2) === m + 1).map(md => +md.slice(3));
}
function isRestDay(y, m, d){
  const wd = weekdayOf(y, m, d);
  return wd === 0 || wd === 6 || holidaysOf(y, m).includes(d);
}

function buildDutyIndex(){
  const byEmp = new Map();
  for(const key in DB.schedule){
    const [empId, dStr] = key.split('|');
    if(!byEmp.has(empId)) byEmp.set(empId, new Map());
    byEmp.get(empId).set(ordOfStr(dStr), DB.schedule[key]);
  }
  return byEmp;
}

function isActive(e){ return (e.status || 'active') === 'active'; }

/* ---------- Thuật toán xếp lịch ---------- */
function autoSchedule(year, month){
  ensureDutySetup();
  const cfg = DB.dutyConfig;
  const rules = cfg.rules;
  const n = daysInMonth(year, month);
  const first = ordOf(year, month, 1);
  const prev = shiftMonth(year, month, -1);
  const prevDays = daysInMonth(prev.year, prev.month);
  const ids = {day: dutyShiftId('day'), night: dutyShiftId('night'), full: dutyShiftId('full')};
  const gapDays = rules.gap ? Math.max(2, Math.round(+rules.gapDays) || 2) : 1;
  const roleKeys = DUTY_ROLES.map(r => r.key).filter(k => cfg.roles[k]);
  const changes = new Map();
  const placed = new Set();
  const warnings = [];
  const relaxed = [];
  let assigned = 0;

  const index = buildDutyIndex();
  const has = (id, ord) => !!(index.get(id) && index.get(id).has(ord));
  const shiftAt = (id, ord) => (index.get(id) && index.get(id).get(ord)) || null;
  const write = (id, ord, shiftId) => {
    const key = scheduleKey(id, strOfOrd(ord));
    const before = DB.schedule[key] || null;
    if(before === shiftId) return;
    if(!changes.has(key)) changes.set(key, before);
    if(shiftId) DB.schedule[key] = shiftId; else delete DB.schedule[key];
    if(!index.has(id)) index.set(id, new Map());
    if(shiftId) index.get(id).set(ord, shiftId); else index.get(id).delete(ord);
  };

  const members = {};
  roleKeys.forEach(k => { members[k] = DB.employees.filter(e => e.role === k); });
  if(rules.replace){
    roleKeys.forEach(k => members[k].forEach(e => {
      for(let d = 1; d <= n; d++) write(e.id, first + d - 1, null);
    }));
  }

  // Đơn vị xếp: từng người, hoặc cả tổ (các thành viên cùng tổ trực cùng ngày).
  const units = {};
  roleKeys.forEach(k => {
    const active = members[k].filter(isActive);
    units[k] = [];
    if(cfg.roles[k].unit !== 'group'){
      active.forEach(e => units[k].push({id: e.id, members: [e]}));
      return;
    }
    const byGroup = new Map();
    let loose = 0;
    active.forEach(e => {
      if(!e.group){ loose++; units[k].push({id: e.id, members: [e]}); return; }
      if(!byGroup.has(e.group)){
        const u = {id: 'g:' + e.group, members: []};
        byGroup.set(e.group, u);
        units[k].push(u);
      }
      byGroup.get(e.group).members.push(e);
    });
    if(loose) warnings.push(`${roleLabel(k)}: ${loose} người chưa được chia tổ nên mỗi người được xếp như một tổ riêng.`);
  });

  const everyone = [...new Set(roleKeys.flatMap(k => units[k].flatMap(u => u.members)))];
  const last = new Map(), monthCount = new Map(), restCount = new Map(), restMonth = new Map(), tiebreak = new Map();
  const from = shiftMonth(year, month, -3);
  const restFrom = ordOf(from.year, from.month, 1);
  const restCache = new Map();
  const isRestOrd = ord => {
    if(!restCache.has(ord)){ const x = dateOfOrd(ord); restCache.set(ord, isRestDay(x.y, x.m, x.d)); }
    return restCache.get(ord);
  };
  everyone.forEach(e => {
    let lastOrd = null, cnt = 0, restN = 0, restM = 0;
    (index.get(e.id) || new Map()).forEach((sid, ord) => {
      if(ord < first && (lastOrd === null || ord > lastOrd)) lastOrd = ord;
      if(ord >= first && ord < first + n){ cnt++; if(isRestOrd(ord)) restM++; }
      if(ord >= restFrom && ord < first + n && isRestOrd(ord)) restN++;
    });
    if(lastOrd !== null) last.set(e.id, lastOrd);
    monthCount.set(e.id, cnt);
    restCount.set(e.id, restN);
    restMonth.set(e.id, restM);
    tiebreak.set(e.id, Math.random());
  });

  const metric = u => ({
    count: Math.max(...u.members.map(e => monthCount.get(e.id))),
    rest: Math.max(...u.members.map(e => restCount.get(e.id))),
    restMonth: Math.max(...u.members.map(e => restMonth.get(e.id))),
    last: Math.max(...u.members.map(e => last.has(e.id) ? last.get(e.id) : -1e6)),
    tie: tiebreak.get(u.members[0].id)
  });

  const pickUnits = (k, need, d, ord, kind, rest, shiftUnits) => {
    const rc = cfg.roles[k];
    const label = `${roleLabel(k)} ${DUTY_KINDS[kind].toLowerCase()}`;
    const chosen = [];
    while(chosen.length < need){
      const free = units[k].filter(u => !chosen.includes(u) && u.members.every(e => !has(e.id, ord)));
      if(!free.length) break;
      let pool;
      if(rc.mode === 'week'){
        // Giữ người trực của hôm trước cho tới hết tuần (tuần bắt đầu từ Thứ Hai).
        const holders = weekdayOfOrd(ord) !== 1 ? free.filter(u => u.members.every(e => has(e.id, ord - 1))) : [];
        pool = holders.length ? holders : free;
        pool.sort((a, b) => {
          const ma = metric(a), mb = metric(b);
          return ma.last - mb.last || ma.count - mb.count || ma.tie - mb.tie;
        });
      } else {
        const gapOk = u => !rules.gap || u.members.every(e => {
          for(let g = 1; g < gapDays; g++){ if(has(e.id, ord - g) || has(e.id, ord + g)) return false; }
          return true;
        });
        const sameOk = u => !rules.sameDay || d > prevDays || u.members.every(e => !has(e.id, ordOf(prev.year, prev.month, d)));
        pool = free.filter(u => gapOk(u) && sameOk(u));
        if(!pool.length){
          let note = 'giãn cách giữa hai lần trực';
          pool = free.filter(sameOk);
          if(!pool.length){ pool = free.filter(gapOk); note = 'không trùng ngày trực tháng trước'; }
          if(!pool.length){ pool = free; note = 'giãn cách và không trùng ngày tháng trước'; }
          relaxed.push(`Ngày ${pad2(d)}/${pad2(month + 1)} - ${label}: không đủ người thỏa quy tắc ${note}, đã nới quy tắc.`);
        }
        const clash = u => rules.unit && u.members.some(e => e.unit && shiftUnits.has(normText(e.unit))) ? 1 : 0;
        // Ngày nghỉ: ưu tiên người ít ca nghỉ trong tháng, rồi ít ca trong tháng, rồi ít ca nghỉ 3 tháng gần nhất.
        const weekendFirst = rest && rules.weekend;
        pool.sort((a, b) => {
          const ma = metric(a), mb = metric(b);
          if(weekendFirst && ma.restMonth !== mb.restMonth) return ma.restMonth - mb.restMonth;
          if(ma.count !== mb.count) return ma.count - mb.count;
          if(weekendFirst && ma.rest !== mb.rest) return ma.rest - mb.rest;
          const ba = Math.floor(Math.min(ord - ma.last, 63) / 7);
          const bb = Math.floor(Math.min(ord - mb.last, 63) / 7);
          if(ba !== bb) return bb - ba;
          const ca = clash(a), cb = clash(b);
          if(ca !== cb) return ca - cb;
          return ma.last - mb.last || ma.tie - mb.tie;
        });
      }
      chosen.push(pool[0]);
    }
    if(chosen.length < need) warnings.push(`Ngày ${pad2(d)}/${pad2(month + 1)}: thiếu ${need - chosen.length} ${label}.`);
    return chosen;
  };

  for(let d = 1; d <= n; d++){
    const ord = first + d - 1;
    const rest = isRestDay(year, month, d);
    const shiftUnits = {day: new Set(), night: new Set()};
    const markUnit = (e, kind) => {
      if(!e.unit) return;
      const u = normText(e.unit);
      if(kind !== 'night') shiftUnits.day.add(u);
      if(kind !== 'day') shiftUnits.night.add(u);
    };
    DB.employees.forEach(e => { const kind = dutyKindOf(shiftAt(e.id, ord)); if(kind) markUnit(e, kind); });

    roleKeys.forEach(k => {
      if(!units[k].length) return;
      const spec = rest ? cfg.roles[k].rest : cfg.roles[k].normal;
      const existing = {day: 0, night: 0, full: 0};
      units[k].forEach(u => {
        const kind = dutyKindOf(shiftAt(u.members[0].id, ord));
        if(kind) existing[kind]++;
      });
      const place = (need, kind) => {
        if(need <= 0) return;
        const unitSet = kind === 'night' ? shiftUnits.night : shiftUnits.day;
        pickUnits(k, need, d, ord, kind, rest, unitSet).forEach(u => u.members.forEach(e => {
          write(e.id, ord, ids[kind]);
          placed.add(e.id + '|' + ord);
          assigned++;
          monthCount.set(e.id, monthCount.get(e.id) + 1);
          if(rest){
            restCount.set(e.id, restCount.get(e.id) + 1);
            restMonth.set(e.id, restMonth.get(e.id) + 1);
          }
          markUnit(e, kind);
        }));
      };
      const dayN = +spec.day || 0, nightN = +spec.night || 0;
      if(spec.same && dayN && nightN){
        place(Math.max(dayN, nightN) - existing.full - existing.day - existing.night, 'full');
      } else {
        place(dayN - existing.day - existing.full, 'day');
        place(nightN - existing.night - existing.full, 'night');
      }
    });
    everyone.forEach(e => { if(has(e.id, ord)) last.set(e.id, ord); });
  }

  // Cân bằng lại ca ngày nghỉ: đổi một ca ngày nghỉ của người nhiều nhất lấy một ca ngày thường của người ít nhất,
  // chỉ đổi các ca do lần xếp này tạo ra và không vi phạm quy tắc giãn cách, trùng ngày tháng trước.
  const canMove = (u, fromOrd, toOrd) => u.members.every(e => {
    if(has(e.id, toOrd)) return false;
    if(rules.gap){
      for(let g = 1; g < gapDays; g++){
        if((toOrd - g !== fromOrd && has(e.id, toOrd - g)) || (toOrd + g !== fromOrd && has(e.id, toOrd + g))) return false;
      }
    }
    const d = toOrd - first + 1;
    return !rules.sameDay || d > prevDays || !has(e.id, ordOf(prev.year, prev.month, d));
  });
  const dutyDays = (u, restWanted) => {
    const list = [];
    for(let d = 1; d <= n; d++){
      const ord = first + d - 1;
      if(isRestDay(year, month, d) !== restWanted || !u.members.every(e => placed.has(e.id + '|' + ord))) continue;
      list.push({ord, kind: dutyKindOf(shiftAt(u.members[0].id, ord))});
    }
    return list;
  };
  const trySwap = (hi, lo) => {
    for(const x of dutyDays(hi, true)){
      for(const y of dutyDays(lo, false)){
        if(!canMove(hi, x.ord, y.ord) || !canMove(lo, y.ord, x.ord)) continue;
        hi.members.forEach(e => { write(e.id, x.ord, null); placed.delete(e.id + '|' + x.ord); });
        lo.members.forEach(e => { write(e.id, y.ord, null); placed.delete(e.id + '|' + y.ord); });
        hi.members.forEach(e => {
          write(e.id, y.ord, ids[y.kind]); placed.add(e.id + '|' + y.ord);
          restMonth.set(e.id, restMonth.get(e.id) - 1);
        });
        lo.members.forEach(e => {
          write(e.id, x.ord, ids[x.kind]); placed.add(e.id + '|' + x.ord);
          restMonth.set(e.id, restMonth.get(e.id) + 1);
        });
        return true;
      }
    }
    return false;
  };
  if(rules.weekend){
    roleKeys.forEach(k => {
      if(cfg.roles[k].mode !== 'day' || units[k].length < 2) return;
      for(let round = 0; round < 60; round++){
        const restOf = u => metric(u).restMonth;
        const pairs = [];
        units[k].forEach(hi => units[k].forEach(lo => {
          if(restOf(hi) - restOf(lo) > 1) pairs.push([hi, lo, restOf(hi) - restOf(lo)]);
        }));
        if(!pairs.length) break;
        pairs.sort((a, b) => b[2] - a[2]);
        if(!pairs.some(([hi, lo]) => trySwap(hi, lo))) break;
      }
    });
  }

  cfg.lastRun ={year, month, at: new Date().toISOString(), changes: [...changes.entries()]};
  saveData();
  return {assigned, warnings, relaxed};
}

function undoLastRun(){
  const run = DB.dutyConfig.lastRun;
  if(!run) return null;
  run.changes.forEach(([key, before]) => {
    if(before) DB.schedule[key] = before; else delete DB.schedule[key];
  });
  DB.dutyConfig.lastRun = null;
  saveData();
  return run;
}

/* ---------- Kiểm tra ràng buộc ---------- */
function monthDutyStats(year, month){
  const prefix = monthKey(year, month);
  const stats = new Map();
  for(const key in DB.schedule){
    const [empId, dStr] = key.split('|');
    if(!dStr.startsWith(prefix)) continue;
    const kind = dutyKindOf(DB.schedule[key]);
    if(!kind) continue;
    const d = +dStr.slice(8, 10);
    if(!stats.has(empId)) stats.set(empId, {count: 0, rest: 0, day: 0, night: 0, full: 0, days: []});
    const s = stats.get(empId);
    s.count++;
    s[kind]++;
    if(isRestDay(year, month, d)) s.rest++;
    s.days.push(d);
  }
  stats.forEach(s => s.days.sort((a, b) => a - b));
  return stats;
}

function checkConstraints(year, month){
  ensureDutySetup();
  const cfg = DB.dutyConfig;
  const n = daysInMonth(year, month);
  const first = ordOf(year, month, 1);
  const prev = shiftMonth(year, month, -1);
  const prevDays = daysInMonth(prev.year, prev.month);
  const gapDays = Math.max(2, Math.round(+cfg.rules.gapDays) || 2);
  const index = buildDutyIndex();
  const res = {sameDay: [], gap: [], missing: [], balance: [], balanceOk: []};

  DB.employees.forEach(e => {
    const map = index.get(e.id);
    if(!map) return;
    const rc = cfg.roles[e.role];
    if(rc && rc.mode === 'week') return;
    const who = e.name + (e.unit ? ` (${e.unit})` : '');
    for(let d = 1; d <= Math.min(n, prevDays); d++){
      if(map.has(first + d - 1) && map.has(ordOf(prev.year, prev.month, d))){
        res.sameDay.push(`${who}: trực ngày ${d} của cả tháng ${prev.month + 1}/${prev.year} và tháng ${month + 1}/${year}.`);
      }
    }
    const ords = [...map.keys()].filter(o => o > first - gapDays && o < first + n).sort((a, b) => a - b);
    for(let i = 1; i < ords.length; i++){
      if(ords[i] >= first && ords[i] - ords[i - 1] < gapDays){
        res.gap.push(`${who}: trực ngày ${fmtOrd(ords[i - 1])} và ${fmtOrd(ords[i])} (cách ${ords[i] - ords[i - 1]} ngày).`);
      }
    }
  });

  const stats = monthDutyStats(year, month);
  DUTY_ROLES.forEach(({key}) => {
    const rc = cfg.roles[key];
    const emps = DB.employees.filter(e => e.role === key);
    if(!rc || !emps.length) return;
    for(let d = 1; d <= n; d++){
      const ord = first + d - 1;
      const spec = isRestDay(year, month, d) ? rc.rest : rc.normal;
      const seen = {day: new Set(), night: new Set()};
      emps.forEach(e => {
        const kind = dutyKindOf(index.get(e.id) && index.get(e.id).get(ord));
        if(!kind) return;
        const unitId = rc.unit === 'group' && e.group ? 'g:' + e.group : e.id;
        if(kind !== 'night') seen.day.add(unitId);
        if(kind !== 'day') seen.night.add(unitId);
      });
      const lack = [];
      if((+spec.day || 0) > seen.day.size) lack.push(`thiếu ${spec.day - seen.day.size} trực ngày`);
      if((+spec.night || 0) > seen.night.size) lack.push(`thiếu ${spec.night - seen.night.size} trực đêm`);
      if(lack.length) res.missing.push(`Ngày ${pad2(d)}/${pad2(month + 1)} - ${roleLabel(key)}: ${lack.join(', ')}.`);
    }
    let counted = emps.filter(isActive);
    if(ROTATION_ROLES.includes(key)) counted = counted.filter(e => stats.has(e.id));
    if(counted.length < 2) return;
    const rests = counted.map(e => stats.has(e.id) ? stats.get(e.id).rest : 0);
    const min = Math.min(...rests), max = Math.max(...rests);
    const line = `${roleLabel(key)}: số ca Thứ Bảy, Chủ nhật, ngày lễ của mỗi người từ ${min} đến ${max}.`;
    if(rc.mode === 'week') res.balanceOk.push(line.replace(/\.$/, ' (luân phiên theo tuần, không xét chênh lệch).'));
    else (max - min > 1 ? res.balance : res.balanceOk).push(line);
  });
  return res;
}

/* ---------- Dữ liệu hiển thị ---------- */
function unitDisplay(e){
  const unit = e.unit || '';
  if(e.role !== 'truongca') return unit;
  const short = unit.replace(/^phòng\s*/i, 'P').replace(/^thanh tra$/i, 'Ttra');
  return (short ? short + ' - ' : '') + 'Trưởng ca';
}

function rosterOfDay(year, month, d){
  const dStr = dateStr(year, month, d);
  const rows = [];
  DB.employees.forEach(e => {
    const kind = dutyKindOf(getShiftIdFor(e.id, dStr));
    if(kind) rows.push({emp: e, kind});
  });
  const order = r => {
    const k = r.emp.role;
    if(k === 'lanhdao') return 0;
    if(k === 'truongca' || k === 'ksv') return (r.kind === 'night' ? 20 : 10) + (k === 'ksv' ? 1 : 0);
    if(k === 'vanthu') return 30;
    if(k === 'laixe') return 40;
    return 50;
  };
  rows.sort((a, b) => order(a) - order(b)
    || (a.emp.group || '').localeCompare(b.emp.group || '')
    || compareNames(a.emp.name, b.emp.name));
  return rows;
}

function dayHeading(year, month, d){
  const holiday = holidaysOf(year, month).includes(d);
  return `NGÀY ${pad2(d)}/${pad2(month + 1)} (${WEEKDAY_FULL[weekdayOf(year, month, d)]})${holiday ? ' - NGHỈ LỄ' : ''}`;
}

function offDutyLists(year, month){
  const prefix = monthKey(year, month);
  const onDuty = new Set(Object.keys(DB.schedule).filter(k => k.split('|')[1].startsWith(prefix)).map(k => k.split('|')[0]));
  const sortFn = (a, b) => (a.role === 'truongca' ? 0 : 1) - (b.role === 'truongca' ? 0 : 1)
    || (a.unit || '').localeCompare(b.unit || '', 'vi', {numeric: true})
    || compareNames(a.name, b.name);
  const off = DB.employees.filter(e => !onDuty.has(e.id));
  return {
    rotation: off.filter(e => e.status === 'rotation' || (isActive(e) && ROTATION_ROLES.includes(e.role))).sort(sortFn),
    leave: off.filter(e => e.status === 'leave').sort(sortFn),
    exempt: off.filter(e => e.status === 'exempt').sort(sortFn)
  };
}

function docTitle(year, month){
  return DB.dutyConfig.doc.title.replace('{MM}', pad2(month + 1)).replace('{YYYY}', year);
}
function docLines(text){ return String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
function issueDateText(){
  const t = new Date();
  return `${DB.dutyConfig.doc.place || ''}, ngày ${pad2(t.getDate())} tháng ${pad2(t.getMonth() + 1)} năm ${t.getFullYear()}`;
}

/* ---------- Hiển thị trên trang ---------- */
function rosterTableHtml(year, month, opts = {}){
  const n = daysInMonth(year, month);
  let html = `<table class="roster-table data"><thead><tr><th>STT</th><th>Họ và tên</th><th>Giới tính</th><th>Năm sinh</th><th>Chức danh</th><th>Số điện thoại</th><th>Đơn vị</th><th>Trực ngày</th><th>Trực đêm</th></tr></thead><tbody>`;
  for(let d = 1; d <= n; d++){
    const rows = rosterOfDay(year, month, d);
    html += `<tr class="day-row${isRestDay(year, month, d) ? ' rest' : ''}"><td colspan="9">${dayHeading(year, month, d)}</td></tr>`;
    if(!rows.length) html += '<tr><td colspan="9" class="empty">Chưa phân công</td></tr>';
    rows.forEach((r, i) => {
      const e = r.emp;
      html += `<tr${opts.me === e.id ? ' class="me"' : ''}><td class="c">${i + 1}</td><td>${escapeHtml(e.name)}</td><td class="c">${escapeHtml(e.gender || '')}</td><td class="c">${escapeHtml(e.birthYear || '')}</td><td>${escapeHtml(e.position || '')}</td><td>${escapeHtml(e.phone || '')}</td><td>${escapeHtml(unitDisplay(e))}</td><td class="mark">${r.kind !== 'night' ? '*' : ''}</td><td class="mark">${r.kind !== 'day' ? '*' : ''}</td></tr>`;
    });
  }
  return html + '</tbody></table>';
}

function offDutyListHtml(title, list){
  if(!list.length) return '';
  const rows = list.map((e, i) => `<tr><td class="c">${i + 1}</td><td>${escapeHtml(e.name)}</td><td class="c">${escapeHtml(e.gender || '')}</td><td class="c">${escapeHtml(e.birthYear || '')}</td><td>${escapeHtml(e.position || '')}</td><td>${escapeHtml(e.phone || '')}</td><td>${escapeHtml(unitDisplay(e))}</td><td>${escapeHtml(e.note || '')}</td></tr>`).join('');
  return `<p class="list-title">${escapeHtml(title)}</p><table class="roster-table data"><thead><tr><th>STT</th><th>Họ và tên</th><th>Giới tính</th><th>Năm sinh</th><th>Chức danh</th><th>Số điện thoại</th><th>Đơn vị</th><th>Ghi chú</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function offDutySectionsHtml(year, month){
  const lists = offDutyLists(year, month);
  const mm = `${pad2(month + 1)}/${year}`;
  return offDutyListHtml(`* Những cán bộ nghỉ trực luân phiên tháng ${mm}`, lists.rotation)
    + offDutyListHtml('* Những cán bộ nghỉ chế độ thai sản và lý do khác', lists.leave)
    + offDutyListHtml(`* Những cán bộ không tham gia trực tháng ${mm}`, lists.exempt);
}

function calendarHtml(year, month){
  const n = daysInMonth(year, month);
  const lead = (weekdayOf(year, month, 1) + 6) % 7;
  const heads = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ nhật'];
  let html = `<table class="cal-table"><thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody><tr>`;
  for(let i = 0; i < lead; i++) html += '<td class="blank"></td>';
  for(let d = 1; d <= n; d++){
    const col = (lead + d - 1) % 7;
    if(col === 0 && d > 1) html += '</tr><tr>';
    const lines = rosterOfDay(year, month, d).map(r =>
      `<div class="cal-line k-${r.kind}" title="${escapeHtml(DUTY_KINDS[r.kind])}"><b>${escapeHtml(ROLE_SHORT[r.emp.role] || '')}</b> ${escapeHtml(r.emp.name)}</div>`).join('');
    const holiday = holidaysOf(year, month).includes(d);
    html += `<td class="${isRestDay(year, month, d) ? 'rest' : ''}"><div class="cal-day">${d}${holiday ? ' <span class="cal-holiday">Nghỉ lễ</span>' : ''}</div>${lines || '<div class="cal-empty">Chưa phân công</div>'}</td>`;
  }
  const tail = (7 - (lead + n) % 7) % 7;
  for(let i = 0; i < tail; i++) html += '<td class="blank"></td>';
  html += '</tr></tbody></table>';
  html += `<div class="legend"><span class="legend-item"><span class="cal-key k-day"></span>Trực ngày</span><span class="legend-item"><span class="cal-key k-night"></span>Trực đêm</span><span class="legend-item"><span class="cal-key k-full"></span>Trực ngày và đêm</span><span class="legend-item">LĐ: Lãnh đạo; TC: Trưởng ca; KSV: Kiểm sát viên; VT: Văn thư; LX: Lái xe</span></div>`;
  return html;
}

function statsHtml(year, month){
  const stats = monthDutyStats(year, month);
  const empty = {count: 0, rest: 0, day: 0, night: 0, full: 0, days: []};
  const groups = [...DUTY_ROLES, {key: '', label: 'Chưa phân vai trò'}];
  let html = '';
  groups.forEach(({key, label}) => {
    const emps = DB.employees.filter(e => (e.role || '') === key && (isActive(e) || stats.has(e.id)))
      .sort((a, b) => (a.group || '').localeCompare(b.group || '') || compareNames(a.name, b.name));
    if(!emps.length || (!key && !emps.some(e => stats.has(e.id)))) return;
    const rows = emps.map(e => ({e, s: stats.get(e.id) || empty}));
    const counts = rows.map(r => r.s.count), rests = rows.map(r => r.s.rest);
    html += `<div class="stats-role"><h4>${escapeHtml(label)} <span class="hint">${emps.length} người; số ca mỗi người ${Math.min(...counts)}–${Math.max(...counts)}; ca Thứ Bảy, Chủ nhật, ngày lễ ${Math.min(...rests)}–${Math.max(...rests)}</span></h4>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>Họ và tên</th><th>Đơn vị</th><th>Tổ</th><th>Số ca</th><th>Thứ Bảy, CN, lễ</th><th>Trực ngày</th><th>Trực đêm</th><th>Ngày và đêm</th><th>Các ngày trực</th></tr></thead><tbody>
      ${rows.map(({e, s}) => `<tr><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.unit || '')}</td><td>${escapeHtml(e.group || '')}</td><td>${s.count}</td><td>${s.rest}</td><td>${s.day}</td><td>${s.night}</td><td>${s.full}</td><td class="wrap">${s.days.join(', ')}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  });
  return html || '<p class="hint">Chưa có dữ liệu.</p>';
}

function renderAutoPanel(){
  if(!document.getElementById('panel-auto')) return;
  ensureDutySetup();
  const {year, month} = autoView;
  const cfg = DB.dutyConfig;
  document.getElementById('auto-month-label').textContent = `${MONTH_NAMES[month]} năm ${year}`;

  const prev = shiftMonth(year, month, -1);
  const prevPrefix = monthKey(prev.year, prev.month);
  const prevCount = Object.keys(DB.schedule).filter(k => k.split('|')[1].startsWith(prevPrefix)).length;
  document.getElementById('auto-prev-info').textContent = prevCount
    ? `Tháng trước (${pad2(prev.month + 1)}/${prev.year}) có ${prevCount} lượt phân công; hệ thống dùng lịch này để tránh trùng ngày và trực liên tiếp khi nối tháng.`
    : `Chưa có lịch tháng trước (${pad2(prev.month + 1)}/${prev.year}); các quy tắc nối tháng chưa áp dụng được.`;
  document.getElementById('auto-undo-btn').disabled = !cfg.lastRun;
  document.getElementById('auto-undo-btn').title = cfg.lastRun ? `Lần xếp tháng ${cfg.lastRun.month + 1}/${cfg.lastRun.year}` : '';

  document.getElementById('auto-holidays').value = holidaysOf(year, month).join(', ');
  document.getElementById('rule-sameday').checked = cfg.rules.sameDay;
  document.getElementById('rule-gap').checked = cfg.rules.gap;
  document.getElementById('rule-gap-days').value = cfg.rules.gapDays;
  document.getElementById('rule-weekend').checked = cfg.rules.weekend;
  document.getElementById('rule-unit').checked = cfg.rules.unit;
  document.getElementById('rule-replace').checked = cfg.rules.replace;

  renderStructureTable();
  renderGroupSummary();

  document.querySelectorAll('.view-tab').forEach(b => b.classList.toggle('active', b.dataset.view === autoTab));
  ['roster', 'calendar', 'stats'].forEach(v => { document.getElementById('auto-view-' + v).hidden = v !== autoTab; });
  const view = document.getElementById('auto-view-' + autoTab);
  if(autoTab === 'roster'){
    view.innerHTML = `<div class="table-scroll">${rosterTableHtml(year, month)}</div>${offDutySectionsHtml(year, month)}`;
  } else if(autoTab === 'calendar'){
    view.innerHTML = `<div class="table-scroll">${calendarHtml(year, month)}</div>`;
  } else {
    view.innerHTML = statsHtml(year, month);
  }
}

function renderStructureTable(){
  const cfg = DB.dutyConfig;
  const num = (role, path, value) => `<input type="number" min="0" max="20" data-role="${role}" data-path="${path}" value="${+value || 0}">`;
  document.getElementById('auto-structure-tbody').innerHTML = DUTY_ROLES.map(({key, label}) => {
    const rc = cfg.roles[key];
    const active = DB.employees.filter(e => e.role === key && isActive(e));
    const groupCount = new Set(active.map(e => e.group).filter(Boolean)).size;
    const activeText = rc.unit === 'group' ? `${active.length} người, ${groupCount} tổ` : `${active.length} người`;
    return `<tr>
      <td>${escapeHtml(label)}</td>
      <td>${activeText}</td>
      <td>${num(key, 'normal.night', rc.normal.night)}</td>
      <td>${num(key, 'rest.day', rc.rest.day)}</td>
      <td>${num(key, 'rest.night', rc.rest.night)}</td>
      <td class="c"><input type="checkbox" data-role="${key}" data-path="rest.same"${rc.rest.same ? ' checked' : ''} aria-label="Cùng người trực cả ngày và đêm"></td>
      <td><select data-role="${key}" data-path="mode"><option value="day"${rc.mode === 'day' ? ' selected' : ''}>Theo ngày</option><option value="week"${rc.mode === 'week' ? ' selected' : ''}>Theo tuần</option></select></td>
      <td><select data-role="${key}" data-path="unit"><option value="person"${rc.unit === 'person' ? ' selected' : ''}>Từng người</option><option value="group"${rc.unit === 'group' ? ' selected' : ''}>Theo tổ</option></select></td>
    </tr>`;
  }).join('');
}

function saveStructure(){
  const cfg = DB.dutyConfig;
  document.querySelectorAll('#auto-structure-tbody [data-role]').forEach(input => {
    const rc = cfg.roles[input.dataset.role];
    const [a, b] = input.dataset.path.split('.');
    let value = input.type === 'checkbox' ? input.checked : input.value;
    if(input.type === 'number') value = Math.max(0, Math.min(20, Math.round(+value) || 0));
    if(b) rc[a][b] = value; else rc[a] = value;
  });
  saveData();
  renderAutoPanel();
  showToast('Đã lưu cơ cấu ca trực.');
}

function renderGroupSummary(){
  const roleSel = document.getElementById('group-role');
  if(!roleSel.options.length) fillSelect(roleSel, DUTY_ROLES.map(r => [r.key, r.label]));
  if(!roleSel.dataset.init){ roleSel.value = 'laixe'; roleSel.dataset.init = '1'; }
  const emps = DB.employees.filter(e => e.role === roleSel.value && isActive(e));
  const groups = new Map();
  emps.forEach(e => {
    const g = e.group || '(Chưa chia tổ)';
    if(!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e.name);
  });
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'vi', {numeric: true}));
  document.getElementById('group-summary').innerHTML = emps.length
    ? names.map(g => `<div class="group-item"><b>${escapeHtml(g)}</b> (${groups.get(g).length}): ${escapeHtml(groups.get(g).join(', '))}</div>`).join('')
    : '<p class="hint">Chưa có người đang tham gia trực thuộc vai trò này.</p>';
}

function splitGroups(roleKey, count, prefix){
  const emps = DB.employees.filter(e => e.role === roleKey && isActive(e))
    .sort((a, b) => (a.unit || '').localeCompare(b.unit || '', 'vi', {numeric: true}) || compareNames(a.name, b.name));
  const k = Math.max(1, Math.min(count, emps.length));
  // Chia vòng tròn: số người các tổ chênh nhau tối đa 1, người cùng đơn vị được rải đều.
  emps.forEach((e, i) => { e.group = `${prefix} ${(i % k) + 1}`; });
  return {people: emps.length, groups: k};
}

function checkReportHtml(res, year, month){
  const block = (title, list, okText) => {
    if(!list.length) return `<div class="report-item"><div class="report-name check-ok">✓ ${escapeHtml(title)}</div><ul><li>${escapeHtml(okText)}</li></ul></div>`;
    const shown = list.slice(0, 40).map(x => `<li>${escapeHtml(x)}</li>`).join('');
    const more = list.length > 40 ? `<li>... và ${list.length - 40} trường hợp khác.</li>` : '';
    return `<div class="report-item error"><div class="report-name check-bad">✗ ${escapeHtml(title)} (${list.length})</div><ul>${shown}${more}</ul></div>`;
  };
  return `<p class="hint report-time">Kết quả kiểm tra lịch trực tháng ${month + 1}/${year}.</p>`
    + block('Không trùng số ngày trực với tháng trước', res.sameDay, 'Không có người trực trùng số ngày với tháng trước.')
    + block('Giãn cách giữa hai lần trực (kể cả nối tháng)', res.gap, `Mọi lần trực cách nhau ít nhất ${DB.dutyConfig.rules.gapDays} ngày.`)
    + block('Đủ số người theo cơ cấu ca trực', res.missing, 'Các ngày đều đủ người theo cơ cấu.')
    + block('Cân bằng ca Thứ Bảy, Chủ nhật, ngày lễ (chênh lệch không quá 1)', res.balance, res.balanceOk.join(' ') || 'Không có dữ liệu để so sánh.');
}

function showHtmlReport(title, html){
  document.getElementById('report-title').textContent = title;
  document.getElementById('report-body').innerHTML = html;
  openModal('modal-report');
}

function runAutoSchedule(){
  const {year, month} = autoView;
  const cfg = DB.dutyConfig;
  const roleCount = DB.employees.filter(e => e.role && isActive(e)).length;
  if(!roleCount){
    showHtmlReport('Chưa thể xếp lịch', '<p class="hint report-time">Chưa có nhân viên nào được khai báo vai trò trực. Hãy nhập lịch trực từ tệp Excel hoặc khai báo vai trò ở mục Danh sách nhân viên.</p>');
    return;
  }
  const text = `Xếp lịch trực tự động tháng ${month + 1}/${year}? `
    + (cfg.rules.replace ? 'Lịch hiện có của những người có vai trò trực trong tháng này sẽ được thay thế.' : 'Chỉ bổ sung vào các vị trí còn thiếu.')
    + ' Có thể hoàn tác sau khi xếp.';
  confirmDialog(text, () => {
    const result = autoSchedule(year, month);
    const res = checkConstraints(year, month);
    renderScheduleTable();
    renderAutoPanel();
    const list = items => items.slice(0, 30).map(x => `<li class="report-warn">${escapeHtml(x)}</li>`).join('')
      + (items.length > 30 ? `<li>... và ${items.length - 30} cảnh báo khác.</li>` : '');
    const summary = `<div class="report-item"><div class="report-name">Đã xếp ${result.assigned} lượt trực trong tháng ${month + 1}/${year}</div><ul>
      <li>Lịch tháng trước được dùng để tránh trùng ngày và trực liên tiếp khi nối tháng.</li>
      ${list(result.warnings)}${list(result.relaxed)}</ul></div>`;
    showHtmlReport('Hoàn thành xếp lịch tự động', summary + checkReportHtml(res, year, month));
  });
}

/* ---------- Xuất Excel theo mẫu ban hành ---------- */
function xmlEsc(s){
  return String(s).replace(/[ --]/g, '')
    .replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
}

const XL_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="5">
<font><sz val="12"/><name val="Times New Roman"/><family val="1"/></font>
<font><b/><sz val="12"/><name val="Times New Roman"/><family val="1"/></font>
<font><i/><sz val="12"/><name val="Times New Roman"/><family val="1"/></font>
<font><b/><sz val="14"/><name val="Times New Roman"/><family val="1"/></font>
<font><b/><u/><sz val="12"/><name val="Times New Roman"/><family val="1"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const XS = {plain: 0, boldCenter: 1, italicCenter: 2, title: 3, motto: 4, header: 5, dayRow: 6, cellLeft: 7, cellCenter: 8, boldLeft: 9, italicLeft: 10, center: 11};

function buildRosterSheetXml(year, month){
  const W = 9;
  const col = i => String.fromCharCode(65 + i);
  const rows = [];
  const merges = [];
  const doc = DB.dutyConfig.doc;
  const blank = s => Array.from({length: W}, () => ({v: '', s: s || 0}));
  const add = (cells, height) => { rows.push({cells, height}); return rows.length; };
  const mergeRow = (r, c1, c2) => merges.push(`${col(c1)}${r}:${col(c2)}${r}`);
  const full = (text, s, height) => {
    const cells = blank(s);
    cells[0].v = text;
    mergeRow(add(cells, height), 0, W - 1);
  };
  const split = (left, leftStyle, right, rightStyle) => {
    const cells = blank();
    for(let c = 0; c < 4; c++) cells[c].s = leftStyle;
    for(let c = 4; c < W; c++) cells[c].s = rightStyle;
    cells[0].v = left;
    cells[4].v = right;
    const r = add(cells);
    mergeRow(r, 0, 3);
    mergeRow(r, 4, W - 1);
  };
  const table = (headers, list, toCells) => {
    const head = blank(XS.header);
    headers.forEach((h, i) => { head[i].v = h; });
    add(head, 32);
    list.forEach(item => add(toCells(item)));
  };
  const personCells = (i, e, extra) => {
    const values = [i, e.name, e.gender || '', e.birthYear || '', e.position || '', e.phone || '', unitDisplay(e), ...extra];
    const centered = [0, 2, 3, 7, 8];
    return values.map((v, c) => ({v, s: centered.includes(c) ? XS.cellCenter : XS.cellLeft}));
  };

  split((DB.orgParent || '').toUpperCase(), XS.center, 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', XS.boldCenter);
  split((DB.orgName || '').toUpperCase(), XS.boldCenter, 'Độc lập - Tự do - Hạnh phúc', XS.motto);
  split('', XS.plain, issueDateText(), XS.italicCenter);
  add(blank());
  full(docTitle(year, month).toUpperCase(), XS.title, 24);
  docLines(doc.info).forEach(line => full(line, XS.boldCenter));
  add(blank());

  const headers = ['STT', 'HỌ VÀ TÊN', 'GIỚI TÍNH', 'NĂM SINH', 'CHỨC DANH', 'SỐ ĐIỆN THOẠI', 'ĐƠN VỊ', 'TRỰC NGÀY', 'TRỰC ĐÊM'];
  const head = blank(XS.header);
  headers.forEach((h, i) => { head[i].v = h; });
  add(head, 32);
  for(let d = 1; d <= daysInMonth(year, month); d++){
    full(dayHeading(year, month, d), XS.dayRow);
    rosterOfDay(year, month, d).forEach((r, i) => {
      add(personCells(i + 1, r.emp, [r.kind !== 'night' ? '*' : '', r.kind !== 'day' ? '*' : '']));
    });
  }

  add(blank());
  const recipients = docLines(doc.recipients);
  const signLines = docLines(doc.signTitle);
  const footerLen = Math.max(recipients.length + 1, signLines.length);
  for(let i = 0; i < footerLen; i++){
    const cells = blank();
    if(i === 0){ cells[1] = {v: 'Nơi nhận:', s: XS.boldLeft}; }
    else if(recipients[i - 1]){ cells[1] = {v: '- ' + recipients[i - 1].replace(/^-\s*/, ''), s: XS.italicLeft}; }
    for(let c = 5; c < W; c++) cells[c].s = XS.boldCenter;
    cells[5].v = signLines[i] || '';
    const r = add(cells);
    mergeRow(r, 1, 4);
    mergeRow(r, 5, W - 1);
  }
  for(let i = 0; i < 3; i++) add(blank());
  const signer = blank();
  for(let c = 5; c < W; c++) signer[c].s = XS.boldCenter;
  signer[5].v = doc.signer || '';
  mergeRow(add(signer), 5, W - 1);

  const lists = offDutyLists(year, month);
  const mm = `${pad2(month + 1)}/${year}`;
  const listHeaders = ['STT', 'HỌ VÀ TÊN', 'GIỚI TÍNH', 'NĂM SINH', 'CHỨC DANH', 'SỐ ĐIỆN THOẠI', 'ĐƠN VỊ', 'GHI CHÚ', ''];
  [[`* Những cán bộ nghỉ trực luân phiên tháng ${mm}`, lists.rotation],
   ['* Những cán bộ nghỉ chế độ thai sản và lý do khác', lists.leave],
   [`* Những cán bộ không tham gia trực tháng ${mm}`, lists.exempt]].forEach(([title, list]) => {
    if(!list.length) return;
    add(blank());
    full(title, XS.boldLeft);
    const startRow = rows.length + 1;
    table(listHeaders, list.map((e, i) => [i + 1, e]), ([i, e]) => personCells(i, e, [e.note || '', '']));
    for(let r = startRow; r <= rows.length; r++) mergeRow(r, 7, 8);
  });

  const widths = [6, 26, 9, 9, 16, 15, 18, 9, 9];
  const sheetRows = rows.map((row, i) => {
    const r = i + 1;
    const attrs = row.height ? ` ht="${row.height}" customHeight="1"` : '';
    const cells = row.cells.map((cell, c) => {
      const ref = `${col(c)}${r}`;
      if(cell.v === '' || cell.v === null || cell.v === undefined) return cell.s ? `<c r="${ref}" s="${cell.s}"/>` : '';
      if(typeof cell.v === 'number') return `<c r="${ref}" s="${cell.s}"><v>${cell.v}</v></c>`;
      return `<c r="${ref}" s="${cell.s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(cell.v)}</t></is></c>`;
    }).join('');
    return `<row r="${r}"${attrs}>${cells}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:${col(W - 1)}${rows.length}"/>
<sheetViews><sheetView workbookViewId="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="15.75"/>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${sheetRows}</sheetData>
<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>
<pageMargins left="0.4" right="0.3" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

function buildRosterZip(year, month){
  const zip = new JSZip();
  const sheetName = `Lich truc T${pad2(month + 1)}-${year}`;
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.file('xl/styles.xml', XL_STYLES);
  zip.file('xl/worksheets/sheet1.xml', buildRosterSheetXml(year, month));
  return zip;
}

/* ---------- Xuất Word, in PDF ---------- */
function rosterDocHtml(year, month, mode){
  const doc = DB.dutyConfig.doc;
  const title = docTitle(year, month);
  const recipients = docLines(doc.recipients);
  const css = `
body{font-family:"Times New Roman",Times,serif;font-size:12pt;color:#000}
p{margin:0 0 2pt}
table.doc-head{width:100%;border-collapse:collapse}
table.doc-head td{width:50%;text-align:center;vertical-align:top;border:none;padding:0}
.b{font-weight:bold}.i{font-style:italic}.u{text-decoration:underline}
h1{text-align:center;font-size:14pt;margin:16pt 0 4pt}
.info{text-align:center;font-weight:bold;font-size:11.5pt}
table.data{border-collapse:collapse;width:100%;margin-top:8pt}
table.data th,table.data td{border:1px solid #000;padding:2pt 4pt;font-size:10.5pt;vertical-align:middle}
table.data th{font-weight:bold;text-align:center;background:#d9e1f2}
td.c,td.mark{text-align:center}
td.mark{font-weight:bold}
tr.day-row td{font-weight:bold;background:#f2f2f2}
td.empty{font-style:italic;color:#555}
table.sign{width:100%;border-collapse:collapse;margin-top:12pt}
table.sign td{vertical-align:top;border:none;padding:0;font-size:11pt}
.list-title{font-weight:bold;margin-top:16pt}
thead{display:table-header-group}
tr{page-break-inside:avoid}`;
  const inner = `
<table class="doc-head"><tr>
  <td><p>${escapeHtml((DB.orgParent || '').toUpperCase())}</p><p class="b">${escapeHtml((DB.orgName || '').toUpperCase())}</p></td>
  <td><p class="b">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</p><p class="b u">Độc lập - Tự do - Hạnh phúc</p><p class="i">${escapeHtml(issueDateText())}</p></td>
</tr></table>
<h1>${escapeHtml(title.toUpperCase())}</h1>
${docLines(doc.info).map(l => `<p class="info">${escapeHtml(l)}</p>`).join('')}
${rosterTableHtml(year, month)}
<table class="sign"><tr>
  <td><p class="b i">Nơi nhận:</p>${recipients.map(r => `<p>- ${escapeHtml(r.replace(/^-\s*/, ''))}</p>`).join('')}</td>
  <td style="text-align:center">${docLines(doc.signTitle).map(l => `<p class="b">${escapeHtml(l)}</p>`).join('')}<p>&nbsp;</p><p>&nbsp;</p><p>&nbsp;</p><p class="b">${escapeHtml(doc.signer || '')}</p></td>
</tr></table>
${offDutySectionsHtml(year, month)}`;

  if(mode === 'doc'){
    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>@page WordSection1{size:595.3pt 841.9pt;margin:42pt 36pt 42pt 48pt}div.WordSection1{page:WordSection1}${css}</style>
</head><body><div class="WordSection1">${inner}</div></body></html>`;
  }
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>@page{size:A4 portrait;margin:12mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}${css}</style>
</head><body>${inner}</body></html>`;
}

function rosterFileBase(){ return `lich-truc-thang-${pad2(autoView.month + 1)}-${autoView.year}`; }

async function exportRosterXlsx(){
  const name = rosterFileBase() + '.xlsx';
  const target = await pickSaveTarget(name, XLSX_MIME, '.xlsx');
  if(!target) return;
  const blob = await buildRosterZip(autoView.year, autoView.month).generateAsync({type: 'blob', mimeType: XLSX_MIME, compression: 'DEFLATE'});
  const saved = await writeToTarget(target, blob, name);
  showToast(`Đã xuất lịch trực ra tệp "${saved}".`);
}

async function exportRosterDoc(){
  const name = rosterFileBase() + '.doc';
  const target = await pickSaveTarget(name, 'application/msword', '.doc');
  if(!target) return;
  const blob = new Blob(['﻿', rosterDocHtml(autoView.year, autoView.month, 'doc')], {type: 'application/msword'});
  const saved = await writeToTarget(target, blob, name);
  showToast(`Đã xuất lịch trực ra tệp "${saved}".`);
}

function printRoster(){
  const title = rosterFileBase();
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  frame.srcdoc = rosterDocHtml(autoView.year, autoView.month, 'pdf');
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

/* ---------- Nhập lịch trực theo mẫu ban hành ---------- */
function expandUnit(raw){
  const t = cellText(raw);
  const n = normText(t);
  let m = n.match(/^p\.?\s*(\d+)$/) || n.match(/^phong\s*(\d+)$/);
  if(m) return `Phòng ${+m[1]}`;
  if(n === 'ttra' || n === 'thanh tra') return 'Thanh tra';
  return t;
}

function parseRosterPerson(row, info){
  const p = {name: cellText(row[info.nameCol]), gender: '', birthYear: '', position: '', note: '', phone: '', unit: '', role: ''};
  const stop = [info.phoneCol, info.unitCol, info.dayDutyCol].find(c => c > info.nameCol);
  for(let c = info.nameCol + 1; c < stop; c++){
    const raw = row[c];
    if(typeof raw === 'number' && raw > 3000){ p.note = XLSX.SSF.format('dd/mm/yyyy', raw); continue; }
    const t = cellText(raw);
    if(!t) continue;
    const n = normText(t);
    if(n === 'nam' || n === 'nu') p.gender = n === 'nam' ? 'Nam' : 'Nữ';
    else if(/^(19|20)\d{2}$/.test(t)) p.birthYear = t;
    else if(/ksv|kiem sat vien|van thu|lai xe|chuyen vien|nhan vien|ke toan|bao ve|thu ky|tap su/.test(n)) p.position = t;
    else if(n !== 'vpth') p.note = t;
  }
  if(info.genderCol > info.nameCol && !p.gender) p.gender = cellText(row[info.genderCol]);
  if(info.phoneCol >= 0){
    const raw = row[info.phoneCol];
    p.phone = typeof raw === 'number' ? '0' + String(raw) : cellText(raw);
  }
  const unitRaw = info.unitCol >= 0 ? cellText(row[info.unitCol]) : '';
  const nUnit = normText(unitRaw);
  const nPos = normText(p.position);
  if(/-\s*truong ca$/.test(nUnit)){
    p.role = 'truongca';
    p.unit = expandUnit(unitRaw.replace(/\s*-\s*[^-]*$/, ''));
  } else {
    p.unit = expandUnit(unitRaw);
    if(nUnit.includes('lanh dao')) p.role = 'lanhdao';
    else if(nPos.includes('van thu')) p.role = 'vanthu';
    else if(nPos.includes('lai xe')) p.role = 'laixe';
    else if(/ksv|kiem sat vien/.test(nPos)) p.role = 'ksv';
  }
  return p;
}

function findOrCreateRosterEmployee(p, ctx){
  const same = DB.employees.filter(e => nameKey(e.name) === nameKey(p.name));
  const digits = p.phone.replace(/\D/g, '');
  const sameUnit = e => !p.unit || !e.unit || normText(e.unit) === normText(p.unit);
  let emp = digits
    ? same.find(e => (e.phone || '').replace(/\D/g, '') === digits) || same.find(e => !e.phone && sameUnit(e))
    : same.find(e => p.unit && normText(e.unit || '') === normText(p.unit)) || same[0];
  if(!emp){
    emp = {id: uid('emp'), name: p.name, gender: p.gender, birthYear: p.birthYear, position: p.position, unit: p.unit,
      phone: p.phone, role: p.role, group: '', status: 'active', note: p.note, hasPassword: false};
    DB.employees.push(emp);
    ctx.employeesAdded.push(emp.id);
    return emp;
  }
  ['gender', 'birthYear', 'position', 'unit', 'phone', 'role', 'note'].forEach(field => {
    if(p[field] && emp[field] !== p[field]){
      emp[field] = p[field];
      ctx.employeesUpdated.add(emp.id);
    }
  });
  return emp;
}

function importRoster(sheet, ctx){
  const {rows, info} = sheet;
  if(!info.period){
    ctx.warnings.push(`"${sheet.name}": không xác định được tháng/năm của lịch trực (cần tiêu đề dạng "LỊCH TRỰC THÁNG 09/2026").`);
    return;
  }
  ensureDutySetup();
  const {year, month} = info.period;
  const ids = {day: dutyShiftId('day'), night: dutyShiftId('night'), full: dutyShiftId('full')};
  const doc = DB.dutyConfig.doc;
  const assigned = new Set();
  const holidayDays = new Set();
  const driverDays = new Map();
  const statusMarks = [];
  const footer = {recipients: [], signTitle: [], signer: ''};
  let section = 'duty';
  let date = null;

  for(let r = info.headerRow + 1; r < rows.length; r++){
    const row = rows[r] || [];
    const texts = row.map(cellText);
    const joined = normText(texts.filter(Boolean).join(' '));
    if(!joined) continue;

    const dm = joined.match(/^ngay\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})/);
    if(dm){
      const mm = +dm[2] - 1;
      const yy = year + (mm === 0 && month === 11 ? 1 : 0) - (mm === 11 && month === 0 ? 1 : 0);
      date = validDate(yy, mm, +dm[1]);
      section = 'duty';
      if(!date) ctx.warnings.push(`"${sheet.name}", dòng ${r + 1}: ngày không hợp lệ.`);
      continue;
    }
    if(joined.includes('noi nhan')) section = 'footer';
    if(joined.includes('nghi truc luan phien')){ section = 'rotation'; continue; }
    if(joined.includes('thai san') || joined.includes('ly do khac')){ section = 'leave'; continue; }
    if(joined.includes('khong truc')){ section = 'exempt'; continue; }

    if(section === 'footer'){
      texts.forEach((t, c) => {
        if(!t || normText(t).startsWith('noi nhan')) return;
        if(c <= info.nameCol + 2) footer.recipients.push(t.replace(/^[-–]\s*/, ''));
        else if(t === t.toUpperCase()) footer.signTitle.push(t);
        else footer.signer = t;
      });
      continue;
    }

    const name = cellText(row[info.nameCol]);
    if(!isPersonName(name) || NAME_HEADERS.includes(normText(name))) continue;
    if(section === 'duty' && !date) continue;
    const emp = findOrCreateRosterEmployee(parseRosterPerson(row, info), ctx);

    if(section === 'duty'){
      const onDay = !!cellText(row[info.dayDutyCol]);
      const onNight = !!cellText(row[info.nightDutyCol]);
      if(!onDay && !onNight) continue;
      const kind = onDay && onNight ? 'full' : (onDay ? 'day' : 'night');
      applyShift(emp.id, date, ids[kind], ctx);
      assigned.add(emp.id);
      const [y, m, d] = date.split('-').map(Number);
      const wd = weekdayOf(y, m - 1, d);
      if(onDay && wd !== 0 && wd !== 6 && m - 1 === month) holidayDays.add(d);
      if(emp.role === 'laixe'){
        if(!driverDays.has(date)) driverDays.set(date, []);
        driverDays.get(date).push(emp.id);
      }
    } else if(section === 'leave'){
      const note = [info.dayDutyCol, info.nightDutyCol].map(c => cellText(row[c])).filter(Boolean).join(' ');
      statusMarks.push([emp, 'leave', note]);
    } else if(section === 'exempt'){
      statusMarks.push([emp, 'exempt', '']);
    }
  }

  statusMarks.forEach(([emp, status, note]) => {
    if(assigned.has(emp.id)) return;
    if(emp.status !== status){ emp.status = status; ctx.employeesUpdated.add(emp.id); }
    if(note && emp.note !== note){ emp.note = note; ctx.employeesUpdated.add(emp.id); }
  });

  // Lái xe đi cùng nhau trong các ngày trực được ghép thành tổ (khi chưa chia tổ).
  const drivers = DB.employees.filter(e => e.role === 'laixe');
  if(drivers.length && drivers.every(e => !e.group) && driverDays.size){
    const parent = new Map(drivers.map(e => [e.id, e.id]));
    const find = id => { while(parent.get(id) !== id) id = parent.get(id); return id; };
    driverDays.forEach(list => list.slice(1).forEach(id => parent.set(find(id), find(list[0]))));
    const comps = new Map();
    [...driverDays.values()].flat().forEach(id => {
      const root = find(id);
      if(!comps.has(root)) comps.set(root, new Set());
      comps.get(root).add(id);
    });
    const sizes = [...comps.values()].map(s => s.size);
    if(comps.size >= 2 && sizes.every(s => s >= 2 && s <= 4)){
      [...comps.values()].forEach((set, i) => set.forEach(id => {
        findEmployee(id).group = `Tổ ${i + 1}`;
        ctx.employeesUpdated.add(id);
      }));
    }
  }

  if(holidayDays.size) DB.dutyConfig.holidays[monthKey(year, month)] = [...holidayDays].sort((a, b) => a - b);

  // Thông tin văn bản: tiêu đề, địa điểm, số máy trực, nơi nhận, người ký.
  const headRows = rows.slice(0, info.headerRow).map(row => row.map(cellText).filter(Boolean));
  const titleIdx = headRows.findIndex(cells => cells.some(t => normText(t).includes('lich truc')));
  if(titleIdx >= 0){
    const titleText = headRows[titleIdx].find(t => normText(t).includes('lich truc'));
    doc.title = titleText.replace(/\d{1,2}\s*\/\s*\d{4}/, '{MM}/{YYYY}').replace(/(tháng\s*)\d{1,2}(\s*năm\s*)\d{4}/i, '$1{MM}$2{YYYY}');
    const infoLines = headRows.slice(titleIdx + 1).map(cells => cells.join(' ')).filter(Boolean);
    if(infoLines.length) doc.info = infoLines.join('\n');
  }
  headRows.flat().forEach(t => {
    const m = t.match(/^(.+?),\s*ngày\s/i);
    if(m) doc.place = m[1].trim();
  });
  const isDefaultOrg = !DB.orgParent || DB.orgParent === 'Tên cơ quan chủ quản';
  if(isDefaultOrg && headRows[0] && headRows[1] && !normText(headRows[0][0]).includes('cong hoa')){
    DB.orgParent = headRows[0][0];
    DB.orgName = headRows[1][0];
  }
  if(footer.recipients.length) doc.recipients = footer.recipients.join('\n');
  if(footer.signTitle.length) doc.signTitle = footer.signTitle.join('\n');
  if(footer.signer) doc.signer = footer.signer;

  lastImportedPeriod = {year, month};
}

async function importRosterFile(file){
  lastImportedPeriod = null;
  try{
    const record = await processFileData(`may-tinh/${Date.now()}-${file.name}`, file, file.name);
    if(lastImportedPeriod){
      autoView = {...lastImportedPeriod};
      schedView = {...lastImportedPeriod};
      renderScheduleTable();
      renderAutoPanel();
    }
    renderOrgInfo();
    fillDocSettings();
    showReport([{name: file.name, record}], 'Hoàn thành nhập lịch trực');
  }catch(err){
    showReport([{name: file.name, error: 'Không đọc được tệp: ' + err.message}], 'Nhập tệp không thành công');
  }
}

/* ---------- Thiết lập mẫu văn bản ---------- */
const DOC_FIELDS = [['title', 'doc-title'], ['place', 'doc-place'], ['info', 'doc-info'], ['recipients', 'doc-recipients'], ['signTitle', 'doc-sign-title'], ['signer', 'doc-signer']];

function fillDocSettings(){
  DOC_FIELDS.forEach(([field, id]) => { document.getElementById(id).value = DB.dutyConfig.doc[field] || ''; });
  document.getElementById('doc-success').textContent = '';
  document.getElementById('settings-org-parent').value = DB.orgParent;
  document.getElementById('settings-org-name').value = DB.orgName;
}

/* ---------- Lịch chung cho cán bộ tra cứu ---------- */
function renderViewerRoster(){
  const el = document.getElementById('viewer-roster');
  if(!el || !currentUser || currentUser.role !== 'viewer') return;
  const {year, month} = viewerView;
  el.innerHTML = `<div class="table-scroll">${rosterTableHtml(year, month, {me: currentUser.employeeId})}</div>`;
}

/* ---------- Khởi tạo ---------- */

document.addEventListener('DOMContentLoaded', () => {
  const moveMonth = delta => {
    autoView = shiftMonth(autoView.year, autoView.month, delta);
    renderAutoPanel();
  };
  document.getElementById('auto-prev-month').addEventListener('click', () => moveMonth(-1));
  document.getElementById('auto-next-month').addEventListener('click', () => moveMonth(1));
  document.querySelector('[data-panel="panel-auto"]').addEventListener('click', renderAutoPanel);
  document.querySelector('[data-panel="panel-settings"]').addEventListener('click', fillDocSettings);

  document.getElementById('auto-run-btn').addEventListener('click', runAutoSchedule);
  document.getElementById('auto-check-btn').addEventListener('click', () => {
    showHtmlReport('Kiểm tra ràng buộc', checkReportHtml(checkConstraints(autoView.year, autoView.month), autoView.year, autoView.month));
  });
  document.getElementById('auto-undo-btn').addEventListener('click', () => {
    const run = DB.dutyConfig.lastRun;
    if(!run) return;
    confirmDialog(`Hoàn tác lần xếp lịch tự động tháng ${run.month + 1}/${run.year}? Các ô lịch trực sẽ trở lại như trước khi xếp.`, () => {
      undoLastRun();
      renderScheduleTable();
      renderAutoPanel();
      showToast('Đã hoàn tác lần xếp lịch gần nhất.');
    });
  });

  const importInput = document.getElementById('auto-import-input');
  importInput.addEventListener('change', () => {
    if(importInput.files[0]) importRosterFile(importInput.files[0]);
    importInput.value = '';
  });
  document.getElementById('auto-export-xlsx').addEventListener('click', exportRosterXlsx);
  document.getElementById('auto-export-doc').addEventListener('click', exportRosterDoc);
  document.getElementById('auto-print').addEventListener('click', printRoster);

  document.getElementById('auto-holidays-save').addEventListener('click', () => {
    const {year, month} = autoView;
    const n = daysInMonth(year, month);
    const days = [...new Set(document.getElementById('auto-holidays').value.split(/[^\d]+/).filter(Boolean).map(Number))]
      .filter(d => d >= 1 && d <= n).sort((a, b) => a - b);
    DB.dutyConfig.holidays[monthKey(year, month)] = days;
    saveData();
    renderAutoPanel();
    showToast(days.length ? `Đã lưu ngày nghỉ lễ: ${days.join(', ')}.` : 'Tháng này không có ngày nghỉ lễ.');
  });

  const ruleInputs = {sameDay: 'rule-sameday', gap: 'rule-gap', gapDays: 'rule-gap-days', weekend: 'rule-weekend', unit: 'rule-unit', replace: 'rule-replace'};
  Object.entries(ruleInputs).forEach(([rule, id]) => {
    document.getElementById(id).addEventListener('change', e => {
      DB.dutyConfig.rules[rule] = e.target.type === 'checkbox' ? e.target.checked : Math.max(2, Math.min(15, Math.round(+e.target.value) || 2));
      saveData();
    });
  });

  document.getElementById('auto-structure-save').addEventListener('click', saveStructure);
  document.getElementById('group-role').addEventListener('change', renderGroupSummary);
  document.getElementById('group-split-btn').addEventListener('click', () => {
    const role = document.getElementById('group-role').value;
    const count = Math.round(+document.getElementById('group-count').value) || 1;
    const prefix = document.getElementById('group-prefix').value.trim() || 'Tổ';
    confirmDialog(`Chia lại tổ cho vai trò ${roleLabel(role)} thành ${count} tổ? Tổ hiện tại của những người này sẽ bị thay thế.`, () => {
      const r = splitGroups(role, count, prefix);
      saveData();
      renderAutoPanel();
      renderEmployeesTable();
      showToast(`Đã chia ${r.people} người thành ${r.groups} tổ.`);
    });
  });
  document.getElementById('group-clear-btn').addEventListener('click', () => {
    const role = document.getElementById('group-role').value;
    DB.employees.filter(e => e.role === role).forEach(e => { e.group = ''; });
    saveData();
    renderAutoPanel();
    renderEmployeesTable();
  });

  document.querySelectorAll('.view-tab').forEach(btn => btn.addEventListener('click', () => {
    autoTab = btn.dataset.view;
    renderAutoPanel();
  }));

  document.getElementById('btn-save-doc').addEventListener('click', () => {
    DOC_FIELDS.forEach(([field, id]) => { DB.dutyConfig.doc[field] = document.getElementById(id).value.trim(); });
    saveData();
    document.getElementById('doc-success').textContent = 'Đã lưu mẫu văn bản lịch trực.';
  });
});
