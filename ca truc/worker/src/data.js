import { HttpError } from './http.js';
import { readDoc } from './store.js';

export const DATA_KEY = 'app-data/db.json';
export const MAX_DATA_BYTES = 20 * 1024 * 1024;
const VIEWER_EMPLOYEE_FIELDS = ['id', 'name', 'gender', 'birthYear', 'position', 'phone', 'unit', 'role', 'group', 'status'];

const MAX_SHIFT_NAME_LENGTH = 100;
const MAX_SHIFT_CODE_LENGTH = 10;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

const newId = prefix => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Tên, giờ và màu loại ca được chèn vào giao diện của mọi cán bộ, nên chỉ nhận đúng định dạng.
function isValidShiftType(st) {
  return isPlainObject(st)
    && typeof st.id === 'string' && !!st.id
    && typeof st.name === 'string' && st.name.length <= MAX_SHIFT_NAME_LENGTH
    && (st.code === undefined || (typeof st.code === 'string' && st.code.length <= MAX_SHIFT_CODE_LENGTH))
    && TIME_PATTERN.test(st.start) && TIME_PATTERN.test(st.end)
    && COLOR_PATTERN.test(st.color);
}

export function defaultData() {
  return {
    employees: [],
    shiftTypes: [
      { id: newId('st'), name: 'Trực ngày', code: 'N', start: '07:30', end: '17:00', color: '#1f5fa8' },
      { id: newId('st'), name: 'Trực đêm', code: 'Đ', start: '17:00', end: '07:30', color: '#4b2e83' },
      { id: newId('st'), name: 'Trực ngày và đêm', code: 'NĐ', start: '07:30', end: '07:30', color: '#a31d1d' },
    ],
    schedule: {},
    orgParent: 'Tên cơ quan chủ quản',
    orgName: 'Tên đơn vị',
  };
}

export const readData = env => readDoc(env.FILES, DATA_KEY, defaultData);

export function validateData(data) {
  if (!isPlainObject(data)) throw new HttpError(400, 'Dữ liệu không hợp lệ.');
  if (!Array.isArray(data.employees) || !Array.isArray(data.shiftTypes) || !isPlainObject(data.schedule)) {
    throw new HttpError(400, 'Dữ liệu thiếu danh sách nhân viên, loại ca trực hoặc lịch trực.');
  }
  const ids = new Set();
  for (const emp of data.employees) {
    if (!isPlainObject(emp) || typeof emp.id !== 'string' || !emp.id || typeof emp.name !== 'string') {
      throw new HttpError(400, 'Dữ liệu nhân viên không hợp lệ.');
    }
    if (ids.has(emp.id)) throw new HttpError(400, `Mã nhân viên bị trùng: ${emp.id}.`);
    ids.add(emp.id);
  }
  const invalidShift = data.shiftTypes.find(st => !isValidShiftType(st));
  if (invalidShift !== undefined) {
    const label = isPlainObject(invalidShift) && typeof invalidShift.name === 'string' ? ` "${invalidShift.name.slice(0, 50)}"` : '';
    throw new HttpError(400, `Loại ca${label} có tên, giờ hoặc màu không hợp lệ.`);
  }
}

// Không bao giờ lưu mã băm mật khẩu chung với dữ liệu nghiệp vụ.
export function stripSecrets(data) {
  const { adminPasswordHash, ...rest } = data;
  return { ...rest, employees: data.employees.map(({ pwHash, hasPassword, ...emp }) => emp) };
}

export function forAdmin(data, auth) {
  return { ...data, employees: data.employees.map(emp => ({ ...emp, hasPassword: !!auth.employees[emp.id] })) };
}

// Cán bộ chỉ nhận các cột hiển thị trên lịch trực chung; ghi chú cá nhân và lịch sử nhập tệp được lược bỏ.
export function forViewer(data) {
  const { fileImports, dutyConfig, ...rest } = data;
  const employees = data.employees.map(emp =>
    Object.fromEntries(VIEWER_EMPLOYEE_FIELDS.filter(field => field in emp).map(field => [field, emp[field]]))
  );
  return dutyConfig ? { ...rest, employees, dutyConfig: { ...dutyConfig, lastRun: null } } : { ...rest, employees };
}

export function publicInfo(data, auth) {
  return {
    orgParent: data.orgParent || '',
    orgName: data.orgName || '',
    employees: data.employees.map(emp => ({ id: emp.id, name: emp.name, hasPassword: !!auth.employees[emp.id] })),
  };
}

// Mật khẩu cán bộ nằm trong tệp sao lưu (.json) của bản chạy offline cũ.
export function legacyPasswordHashes(data) {
  return data.employees
    .filter(emp => typeof emp.pwHash === 'string' && /^h[0-9a-z]+$/.test(emp.pwHash))
    .map(emp => [emp.id, emp.pwHash]);
}
