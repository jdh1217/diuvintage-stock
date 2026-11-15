// 纯函数：不碰 DOM 和数据库，app.js 与 node 测试共用

export const MEASURES = ['肩宽', '胸围', '腰围', '臀围', '衣长', '袖长', '裤裙长'];
export const CATEGORIES = ['裙子', '裤子', '上衣', '外套', '包', '鞋', '配饰', '其他'];
export const STATUS = { stock: '在售', reserved: '已预订', sold: '已售' };

const num = v => Number(v) || 0;
const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
const isSold = it => it.status === 'sold' && it.sale;

export function nextCode(items) {
  const max = Math.max(0, ...items.map(it => parseInt(String(it.code).slice(1), 10) || 0));
  return 'D' + String(max + 1).padStart(4, '0');
}

// 关键词用空格分开，全部命中才算匹配
export function matches(item, query = '', f = {}) {
  if (f.status && item.status !== f.status) return false;
  if (f.category && item.category !== f.category) return false;
  if (f.brand && item.brand !== f.brand) return false;
  if (f.batchId && item.batchId !== f.batchId) return false;
  const hay = [item.code, item.name, item.brand, item.category, item.era, item.origin,
    item.condition, item.size, item.notes, item.buyer].filter(Boolean).join(' ').toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(k => hay.includes(k));
}

// 单件盈利 = 成交价 − 卖家承担运费 − 进价 − 额外成本；没卖出返回 null
export function profit(item) {
  if (!isSold(item)) return null;
  return num(item.sale.price) - num(item.sale.shipping) - num(item.cost) - num(item.extraCost);
}

export function monthlyStats(items) {
  const rows = new Map();
  for (const it of items.filter(isSold)) {
    const month = String(it.sale.date || '').slice(0, 7) || '未填日期';
    const r = rows.get(month) ?? { month, count: 0, revenue: 0, profit: 0 };
    r.count++;
    r.revenue += num(it.sale.price);
    r.profit += profit(it);
    rows.set(month, r);
  }
  return [...rows.values()].sort((a, b) => b.month.localeCompare(a.month));
}

export function stockStats(items) {
  const unsold = items.filter(it => it.status !== 'sold');
  return {
    count: unsold.length,
    cost: sum(unsold, it => num(it.cost) + num(it.extraCost)),
    price: sum(unsold, it => num(it.price)),
  };
}

// 整批杂费只算进这一批的总投入，不摊到单件
export function batchStats(batch, items) {
  const own = items.filter(it => it.batchId === batch.id);
  const sold = own.filter(isSold);
  return {
    count: own.length,
    sold: sold.length,
    invested: sum(own, it => num(it.cost) + num(it.extraCost)) + num(batch.fee),
    returned: sum(sold, it => num(it.sale.price) - num(it.sale.shipping)),
  };
}

// 朋友圈文案：只放货品本身的信息，不含进价和备注
export function caption(item) {
  const measures = MEASURES.filter(k => item.measures?.[k]).map(k => `${k}${item.measures[k]}`).join(' ');
  return [
    [item.brand, item.name].filter(Boolean).join(' '),
    [item.era, item.origin].filter(Boolean).join(' · '),
    item.size && `尺码：${item.size}`,
    measures && `尺寸(cm)：${measures}`,
    item.condition && `成色：${item.condition}`,
    num(item.price) > 0 && `¥${item.price}`,
    item.code,
  ].filter(Boolean).join('\n');
}

// 备份文件 = [12 位十进制的清单字节数][JSON 清单][每张照片的原图、缩略图依次拼接]
// 只拼接和切片 Blob，不把照片读进内存
const HEAD = 12;

export function packBackup({ items, batches }, photos, withPhotos) {
  const manifest = {
    app: 'diuvintage', version: 1, exportedAt: Date.now(), withPhotos, items, batches,
    photos: photos.map(p => ({ id: p.id, full: p.full.size, thumb: p.thumb.size })),
  };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  return new Blob([String(json.length).padStart(HEAD, '0'), json, ...photos.flatMap(p => [p.full, p.thumb])]);
}

export async function unpackBackup(blob) {
  const bad = new Error('这不是有效的 diuvintage 备份文件');
  const n = Number(await blob.slice(0, HEAD).text());
  if (!Number.isInteger(n) || n <= 0 || HEAD + n > blob.size) throw bad;
  let m;
  try { m = JSON.parse(await blob.slice(HEAD, HEAD + n).text()); } catch { throw bad; }
  const hasIds = list => Array.isArray(list) && list.every(x => x && typeof x.id === 'string' && x.id);
  if (m?.app !== 'diuvintage' || !hasIds(m.items) || !hasIds(m.batches) || !hasIds(m.photos)) throw bad;

  let at = HEAD + n;
  const take = size => {
    if (!Number.isInteger(size) || size < 0) throw bad;
    const part = blob.slice(at, at + size, 'image/jpeg');
    at += size;
    return part;
  };
  const photos = m.photos.map(p => ({ id: p.id, full: take(p.full), thumb: take(p.thumb) }));
  if (at !== blob.size) throw new Error('备份文件不完整（可能没传完），请重新拿一份');
  return { ...m, photos };
}
