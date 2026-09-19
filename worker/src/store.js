import { HttpError } from './http.js';

// Lưu tài liệu JSON trên R2; ghi có điều kiện theo etag để hai người lưu cùng lúc không đè mất dữ liệu của nhau.
const JSON_META = { httpMetadata: { contentType: 'application/json; charset=utf-8' } };
const MAX_WRITE_ATTEMPTS = 4;

export async function readDoc(bucket, key, makeDefault) {
  const obj = await bucket.get(key);
  if (obj) return { doc: await obj.json(), etag: obj.etag };
  const doc = makeDefault();
  const created = await bucket.put(key, JSON.stringify(doc), JSON_META);
  return { doc, etag: created.etag };
}

// Trả về etag mới, hoặc null nếu tài liệu đã bị người khác thay đổi sau khi đọc.
export async function writeDoc(bucket, key, doc, etag) {
  const saved = await bucket.put(key, JSON.stringify(doc), { ...JSON_META, onlyIf: { etagMatches: etag } });
  return saved ? saved.etag : null;
}

export async function replaceDoc(bucket, key, doc) {
  return (await bucket.put(key, JSON.stringify(doc), JSON_META)).etag;
}

// mutate(doc) trả về { next, result }; next === doc nghĩa là không có gì thay đổi, không cần ghi.
export async function updateDoc(bucket, key, makeDefault, mutate) {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const { doc, etag } = await readDoc(bucket, key, makeDefault);
    const { next, result } = await mutate(doc);
    if (next === doc) return { doc, etag, result };
    const newEtag = await writeDoc(bucket, key, next, etag);
    if (newEtag) return { doc: next, etag: newEtag, result };
  }
  throw new HttpError(503, 'Máy chủ đang bận, vui lòng thử lại.');
}
