import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

const dress = {
  id: 'a', code: 'D0007', name: '碎花茶歇裙', brand: 'Laura Ashley', category: '裙子', era: '80s', origin: '英国',
  condition: '九成新', size: 'M', measures: { 肩宽: '38', 衣长: '110' }, notes: '袖口有小修补',
  price: 480, cost: 120, extraCost: 20, batchId: 'b1', status: 'sold',
  sale: { price: 450, date: '2026-11-03', shipping: 12 }, buyer: '小林',
};
const pants = { id: 'b', code: 'D0008', name: '高腰西裤', brand: 'YSL', category: '裤子', price: 600, cost: 200, batchId: 'b1', status: 'stock' };
const bag = { id: 'c', code: 'D0003', name: '手袋', category: '包', price: 300, cost: 90, status: 'reserved', buyer: '阿May' };
const items = [dress, pants, bag];

test('货号在最大值上递增', () => {
  assert.equal(L.nextCode([]), 'D0001');
  assert.equal(L.nextCode(items), 'D0009');
});

test('搜索：多个关键词都要命中，不分大小写，可叠加筛选', () => {
  assert.ok(L.matches(dress, '裙子'));
  assert.ok(L.matches(dress, 'laura 80s'));
  assert.ok(!L.matches(dress, 'laura 裤子'));
  assert.ok(L.matches(dress, '小林'));
  assert.ok(L.matches(pants, '', { category: '裤子', status: 'stock' }));
  assert.ok(!L.matches(pants, '', { status: 'sold' }));
  assert.ok(!L.matches(bag, '', { batchId: 'b1' }));
  assert.deepEqual(items.filter(i => L.matches(i, '', { brand: 'YSL' })), [pants]);
});

test('单件盈利 = 成交价 − 运费 − 进价 − 额外成本', () => {
  assert.equal(L.profit(dress), 450 - 12 - 120 - 20);
  assert.equal(L.profit(pants), null);
  assert.equal(L.profit(bag), null);
});

test('月度统计只算已售，按月份倒序', () => {
  const dec = { ...pants, status: 'sold', sale: { price: 600, date: '2026-12-01' } };
  assert.deepEqual(L.monthlyStats([dress, dec, bag]), [
    { month: '2026-12', count: 1, revenue: 600, profit: 400 },
    { month: '2026-11', count: 1, revenue: 450, profit: 298 },
  ]);
});

test('库存统计包含在售和已预订', () => {
  assert.deepEqual(L.stockStats(items), { count: 2, cost: 290, price: 900 });
});

test('批次统计：整批杂费算进总投入', () => {
  assert.deepEqual(L.batchStats({ id: 'b1', fee: 60 }, items),
    { count: 2, sold: 1, invested: 120 + 20 + 200 + 60, returned: 450 - 12 });
});

test('朋友圈文案不含进价、备注和买家', () => {
  const text = L.caption(dress);
  assert.equal(text, 'Laura Ashley 碎花茶歇裙\n80s · 英国\n尺码：M\n尺寸(cm)：肩宽38 衣长110\n成色：九成新\n¥480\nD0007');
  for (const secret of ['120', '修补', '小林']) assert.ok(!text.includes(secret));
});

test('备份打包后解包一致，照片字节不变', async () => {
  const photos = [
    { id: 'p1', full: new Blob(['full-one']), thumb: new Blob(['t1']) },
    { id: 'p2', full: new Blob([new Uint8Array([0, 255, 7])]), thumb: new Blob(['']) },
  ];
  const data = { items, batches: [{ id: 'b1', name: '第一批', fee: 60 }] };
  const back = await L.unpackBackup(L.packBackup(data, photos, true));
  assert.deepEqual(back.items, items);
  assert.deepEqual(back.batches, data.batches);
  assert.equal(back.withPhotos, true);
  assert.equal(await back.photos[0].full.text(), 'full-one');
  assert.equal(await back.photos[0].thumb.text(), 't1');
  assert.deepEqual(new Uint8Array(await back.photos[1].full.arrayBuffer()), new Uint8Array([0, 255, 7]));
  assert.equal(back.photos[1].thumb.size, 0);
});

test('备份：不含照片也能打包；坏文件和截断文件被拒绝', async () => {
  const good = L.packBackup({ items, batches: [] }, [], false);
  assert.equal((await L.unpackBackup(good)).withPhotos, false);
  await assert.rejects(L.unpackBackup(new Blob(['hello world, not a backup'])), /不是有效/);
  await assert.rejects(L.unpackBackup(new Blob(['000000000002{}'])), /不是有效/);
  const full = L.packBackup({ items, batches: [] }, [{ id: 'p', full: new Blob(['12345']), thumb: new Blob(['1']) }], true);
  await assert.rejects(L.unpackBackup(full.slice(0, full.size - 3)), /不完整/);
});
