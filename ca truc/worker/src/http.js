// Tiện ích phản hồi HTTP dùng chung cho các tuyến API.
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Name',
  'Access-Control-Max-Age': '86400',
};

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

export async function readJson(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw new HttpError(413, 'Dữ liệu gửi lên quá lớn.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Dữ liệu gửi lên quá lớn.');
  try {
    const body = JSON.parse(text);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'Dữ liệu gửi lên không đúng định dạng.');
  }
}
