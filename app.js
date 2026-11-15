import {
  MEASURES, CATEGORIES, STATUS, nextCode, matches, profit,
  monthlyStats, stockStats, batchStats, caption, packBackup, unpackBackup,
} from './logic.js';

const main = document.querySelector('main');
const dlg = document.querySelector('dialog');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const yuan = n => (n < 0 ? '-¥' : '¥') + Math.abs(Math.round((Number(n) || 0) * 100) / 100);
const today = () => new Date().toLocaleDateString('sv'); // sv 区域的日期写法就是本地时区的 YYYY-MM-DD
const title = i => [i.brand, i.name].filter(Boolean).join(' ') || i.category || '未命名';
const priceText = i => (i.price ? yuan(i.price) : '未定价');
const fileSize = n => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.ceil(n / 1e3) + ' KB');
const money = (name, val, more = '') =>
  `<input name="${name}" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(val || '')}" ${more}>`;

// 任何没被处理的失败都要让店主看到，尤其是存不进去的时候
addEventListener('unhandledrejection', e =>
  alert(e.reason?.name === 'QuotaExceededError' ? '手机存储空间不足，没有保存成功' : '出错了：' + (e.reason?.message ?? e.reason)));

// ---------- 数据库 ----------

const wait = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });

const db = await new Promise((ok, no) => {
  const r = indexedDB.open('diuvintage', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('items', { keyPath: 'id' });
    r.result.createObjectStore('batches', { keyPath: 'id' });
    r.result.createObjectStore('photos'); // 键 = 照片 id，值 = JPEG Blob（长边 1280）
    r.result.createObjectStore('thumbs'); // 同样的键，值 = 缩略图 Blob（长边 320）
  };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => no(r.error);
}).catch(e => {
  main.textContent = '打不开本机数据库，无法使用：' + e.message;
  throw e;
});

const read = (store, method = 'getAll', key) => wait(db.transaction(store).objectStore(store)[method](key));

let items = [];
let batches = [];
async function load() {
  [items, batches] = await Promise.all([read('items'), read('batches')]);
}

// 所有写入都走这里：一笔事务，中途出错整笔回滚，不留半截数据
async function commit(stores, fn) {
  await new Promise((ok, no) => {
    const t = db.transaction(stores, 'readwrite');
    t.oncomplete = ok;
    t.onabort = () => no(t.error ?? new Error('保存失败'));
    try { fn(name => t.objectStore(name)); } catch (e) { t.abort(); no(e); }
  });
  localStorage.lastChange = Date.now();
  await load();
}

// ---------- 照片 ----------

const urls = new Map(); // 照片 id → 缩略图地址，整个会话复用

const thumbImg = id =>
  `<img alt="" ${!id ? '' : urls.has(id) ? `src="${urls.get(id)}"` : `data-thumb="${esc(id)}"`}>`;

function fillThumbs(root) {
  root.querySelectorAll('img[data-thumb]').forEach(async img => {
    const id = img.dataset.thumb;
    if (!urls.has(id)) {
      const blob = await read('thumbs', 'get', id);
      if (!blob) return; // 只恢复了数据、没恢复照片时会缺图
      urls.set(id, URL.createObjectURL(blob));
    }
    img.src = urls.get(id);
  });
}

async function shrink(blob, max, quality) {
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  try { await img.decode(); } finally { URL.revokeObjectURL(img.src); }
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = Object.assign(document.createElement('canvas'), {
    width: Math.round(img.naturalWidth * k),
    height: Math.round(img.naturalHeight * k),
  });
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const out = await new Promise(ok => canvas.toBlob(ok, 'image/jpeg', quality));
  if (!out) throw new Error('照片处理失败');
  return out;
}

// ---------- 弹窗 ----------

// 返回 FormData；取消或按返回键时返回 null
function ask(heading, fields, okText = '确定') {
  dlg.innerHTML = `<form method="dialog"><h2>${heading}</h2>${fields}
    <menu><button value="ok" class="btn primary">${okText}</button><button value="" class="btn" formnovalidate>取消</button></menu></form>`;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(ok => {
    dlg.onclose = () => ok(dlg.returnValue === 'ok' ? new FormData(dlg.querySelector('form')) : null);
  });
}

async function editBatch(b = { id: crypto.randomUUID() }) {
  const f = await ask(b.name ? '编辑批次' : '新建批次', `
    <label>名称<input name="name" required value="${esc(b.name)}"></label>
    <label>进货日期<input name="date" type="date" value="${esc(b.date ?? today())}"></label>
    <label>渠道<input name="source" value="${esc(b.source)}"></label>
    <label>整批杂费（运费等，不摊到单件）${money('fee', b.fee)}</label>`);
  if (!f) return null;
  const next = { ...b, name: f.get('name').trim(), date: f.get('date'), source: f.get('source').trim(), fee: +f.get('fee') || 0 };
  await commit(['batches'], s => s('batches').put(next));
  return next;
}

// ---------- 库存列表 ----------

const filter = { q: '', status: '', category: '', brand: '', batchId: '' };
const PAGE = 40;
let shown = PAGE;
let listY = 0;
let more;

const card = i => `
  <a class="card${i.status === 'sold' ? ' sold' : ''}" href="#/item/${esc(i.id)}">
    ${thumbImg(i.photoIds?.[0])}
    ${i.status === 'stock' ? '' : `<span class="badge ${i.status}">${STATUS[i.status]}</span>`}
    <b>${esc(title(i))}</b>
    <span class="muted">${esc(i.code)}</span>
    <span class="price">${priceText(i)}</span>
  </a>`;

const backupDue = () => {
  const since = +(localStorage.lastBackup || localStorage.firstRun);
  return +localStorage.lastChange > since && Date.now() - since > 7 * 864e5;
};

function listView() {
  const used = new Set(items.map(i => i.category));
  const cats = [...new Set([...CATEGORIES, ...used])].filter(c => c && used.has(c)); // 常用品类按固定顺序排前面
  const brands = [...new Set(items.map(i => i.brand).filter(Boolean))].sort();
  const batch = batches.find(b => b.id === filter.batchId);
  // 筛选项对应的货被改掉或删掉后，别停在一个选不回来的筛选上
  if (!cats.includes(filter.category)) filter.category = '';
  if (!brands.includes(filter.brand)) filter.brand = '';
  if (!batch) filter.batchId = '';

  const chip = (key, val, label) =>
    `<button class="chip${filter[key] === val ? ' on' : ''}" data-act="pick" data-key="${key}" data-val="${esc(val)}">${esc(label)}</button>`;
  main.innerHTML = `
    ${backupDue() ? '<a class="warn" href="#/settings">已经超过 7 天没有备份了，点这里去备份</a>' : ''}
    <header><h1>库存</h1><a class="btn primary" href="#/new">＋ 入库</a></header>
    <input type="search" id="q" aria-label="搜索" placeholder="搜索：品牌、品类、货号、备注…" value="${esc(filter.q)}">
    <div class="chips">${chip('status', '', '全部')}${Object.entries(STATUS).map(([k, v]) => chip('status', k, v)).join('')}</div>
    <div class="chips">${chip('category', '', '全部品类')}${cats.map(c => chip('category', c, c)).join('')}</div>
    <select id="brand" aria-label="品牌"><option value="">全部品牌</option>${brands.map(b => `<option${b === filter.brand ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select>
    ${batch ? `<div class="chips"><button class="chip on" data-act="pick" data-key="batchId" data-val="">批次：${esc(batch.name)} ✕</button></div>` : ''}
    <p id="count" class="muted"></p>
    <div id="grid" class="grid"></div>
    <div id="more"></div>`;

  const grid = main.querySelector('#grid');
  let total = 0;
  const draw = () => {
    const list = items.filter(i => matches(i, filter.q, filter)).sort((a, b) => b.createdAt - a.createdAt);
    total = list.length;
    main.querySelector('#count').textContent = items.length ? `${total} 件` : '还没有货，点右上角「入库」开始';
    grid.innerHTML = list.slice(0, shown).map(card).join('');
    fillThumbs(grid);
  };
  const reset = () => { shown = PAGE; listY = 0; };
  draw();

  main.querySelector('#q').oninput = e => { filter.q = e.target.value; reset(); draw(); };
  main.querySelector('#brand').onchange = e => { filter.brand = e.target.value; reset(); draw(); };
  acts.pick = b => { filter[b.dataset.key] = b.dataset.val; reset(); listView(); };

  more?.disconnect();
  more = new IntersectionObserver(([e]) => {
    if (e.isIntersecting && shown < total) { shown += PAGE; draw(); }
  });
  more.observe(main.querySelector('#more'));
  scrollTo(0, listY); // 从详情返回时回到原来的位置
}

// ---------- 详情 ----------

function itemView(id) {
  const i = items.find(x => x.id === id);
  if (!i) return location.replace('#/');
  const save = async next => { await commit(['items'], s => s('items').put(next)); route(); };
  const batch = batches.find(b => b.id === i.batchId);
  const measures = MEASURES.filter(k => i.measures?.[k]).map(k => `${k} ${i.measures[k]}`).join(' · ');
  const row = (label, val) => (val ? `<dt>${label}</dt><dd>${esc(val)}</dd>` : '');
  const act = (name, label, cls = '') => `<button class="btn ${cls}" data-act="${name}">${label}</button>`;

  main.innerHTML = `
    <header><a class="btn" href="#/">‹ 返回</a><a class="btn" href="#/edit/${esc(i.id)}">编辑</a></header>
    <div class="photos">${(i.photoIds ?? []).map(p => `<img alt="${esc(title(i))}" data-photo="${esc(p)}">`).join('')}</div>
    <h1>${esc(title(i))}</h1>
    <p><span class="muted">${esc(i.code)}</span> <span class="badge ${i.status}">${STATUS[i.status]}</span></p>
    <p class="price big">${priceText(i)}</p>
    ${i.status === 'sold' && i.sale ? `<p>成交 ${yuan(i.sale.price)} · ${esc(i.sale.date)}${i.sale.shipping ? ` · 运费 ${yuan(i.sale.shipping)}` : ''}</p>` : ''}
    <button class="cost" data-act="reveal">进价：点击查看</button>
    <dl>
      ${row(i.status === 'reserved' ? '预订人' : '买家', i.buyer)}
      ${row('品类', i.category)}${row('年代', i.era)}${row('产地', i.origin)}${row('成色', i.condition)}
      ${row('尺码', i.size)}${row('量体 cm', measures)}${row('批次', batch?.name)}${row('备注', i.notes)}
      ${row('入库', new Date(i.createdAt).toLocaleDateString())}
    </dl>
    <div class="actions">
      ${i.status === 'stock' ? act('reserve', '标记预订') : ''}
      ${i.status === 'sold' ? act('undo', '撤销售出') : act('sell', '标记售出', 'primary')}
      ${i.status === 'reserved' ? act('undo', '取消预订') : ''}
      ${act('copy', '复制朋友圈文案')}
      ${act('del', '删除')}
    </div>`;

  main.querySelectorAll('img[data-photo]').forEach(async img => {
    const blob = await read('photos', 'get', img.dataset.photo);
    if (!blob || !img.isConnected) return;
    img.src = URL.createObjectURL(blob);
    viewUrls.push(img.src);
  });

  Object.assign(acts, {
    // 重新进入页面时又会收起，所以不用另做"自动隐藏"
    reveal(b) {
      const p = profit(i);
      b.outerHTML = `<p class="cost">进价 ${yuan(i.cost)}${i.extraCost ? ` · 额外成本 ${yuan(i.extraCost)}` : ''}${p === null ? '' : ` · 盈利 ${yuan(p)}`}</p>`;
    },
    async reserve() {
      const f = await ask('标记预订', `<label>预订人备注<input name="buyer" value="${esc(i.buyer)}"></label>`);
      if (f) await save({ ...i, status: 'reserved', buyer: f.get('buyer').trim() });
    },
    async sell() {
      const f = await ask('标记售出', `
        <label>成交价${money('price', i.price, 'required')}</label>
        <label>售出日期<input name="date" type="date" required value="${today()}"></label>
        <label>买家备注<input name="buyer" value="${esc(i.buyer)}"></label>
        <label>你承担的运费${money('shipping')}</label>`);
      if (!f) return;
      await save({
        ...i, status: 'sold', buyer: f.get('buyer').trim(),
        sale: { price: +f.get('price'), date: f.get('date'), shipping: +f.get('shipping') || 0 },
      });
    },
    async undo() {
      if (i.status === 'sold' && !confirm('撤销后成交价和售出日期会清空，确定吗？')) return;
      await save({ ...i, status: 'stock', sale: null, buyer: '' });
    },
    copy(b) {
      const text = caption(i);
      // 必须在点击里直接调用，Safari 才允许写剪贴板；不行就弹出来手动复制
      navigator.clipboard.writeText(text).then(
        () => { b.textContent = '已复制'; },
        () => ask('朋友圈文案', `<textarea readonly>${esc(text)}</textarea><p class="muted">自动复制没成功，请长按上面的文字手动复制。</p>`),
      );
    },
    async del() {
      if (!confirm(`删除 ${i.code}？照片会一起删掉，不能恢复。`)) return;
      await commit(['items', 'photos', 'thumbs'], s => {
        s('items').delete(i.id);
        (i.photoIds ?? []).forEach(p => { s('photos').delete(p); s('thumbs').delete(p); });
      });
      location.replace('#/');
    },
  });
}

// ---------- 入库 / 编辑 ----------

function formView(id) {
  const old = items.find(x => x.id === id);
  const i = old ?? { id: crypto.randomUUID(), code: nextCode(items), status: 'stock', createdAt: Date.now() };
  const pics = (i.photoIds ?? []).map(p => ({ id: p })); // 新加的照片带 full/thumb，点保存时才写库
  const gone = [];
  const text = (name, label, list = '') =>
    `<label>${label}<input name="${name}" value="${esc(i[name])}" ${list && `list="${list}"`}></label>`;
  const options = list => [...new Set(list)].filter(Boolean).map(v => `<option value="${esc(v)}">`).join('');

  main.innerHTML = `
    <header><h1>${old ? '编辑' : '入库'} ${esc(i.code)}</h1><a class="btn" href="${old ? `#/item/${esc(i.id)}` : '#/'}">取消</a></header>
    <form autocomplete="off">
      <div class="pics"></div>
      <label class="btn">＋ 拍照 / 选照片<input type="file" accept="image/*" multiple hidden></label>
      ${text('name', '名称')}
      <div class="two">${text('category', '品类', 'cats')}${text('brand', '品牌', 'brands')}</div>
      <datalist id="cats">${options([...CATEGORIES, ...items.map(x => x.category)])}</datalist>
      <datalist id="brands">${options(items.map(x => x.brand))}</datalist>
      <div class="two"><label>售价${money('price', i.price)}</label><label>进价${money('cost', i.cost)}</label></div>
      <label>额外成本（清洗、修补等）${money('extraCost', i.extraCost)}</label>
      <label>批次<select name="batchId">
        <option value="">不分批次</option>
        ${batches.map(b => `<option value="${esc(b.id)}"${b.id === i.batchId ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}
        <option value="+">＋ 新建批次…</option>
      </select></label>
      <div class="two">${text('era', '年代')}${text('origin', '产地')}</div>
      <div class="two">${text('condition', '成色')}${text('size', '尺码')}</div>
      <fieldset><legend>量体（cm，选填）</legend>
        ${MEASURES.map(k => `<label>${k}<input name="m:${k}" type="number" inputmode="decimal" step="0.1" min="0" value="${esc(i.measures?.[k])}"></label>`).join('')}
      </fieldset>
      <label>备注<textarea name="notes" rows="3">${esc(i.notes)}</textarea></label>
      <button class="btn primary wide">保存</button>
    </form>`;

  const form = main.querySelector('form');
  const drawPics = () => {
    const box = main.querySelector('.pics');
    box.innerHTML = pics.map((p, n) =>
      `<div>${thumbImg(p.id)}<button type="button" data-act="drop" data-n="${n}" aria-label="移除这张照片">✕</button></div>`).join('');
    fillThumbs(box);
  };
  drawPics();

  acts.drop = b => {
    const [p] = pics.splice(+b.dataset.n, 1);
    if (!p.full) gone.push(p.id); // 已在库里的，保存时一并删除
    drawPics();
  };

  form.querySelector('[type=file]').onchange = async e => {
    for (const file of [...e.target.files]) {
      try {
        const full = await shrink(file, 1280, 0.8);
        const pic = { id: crypto.randomUUID(), full, thumb: await shrink(full, 320, 0.7) };
        urls.set(pic.id, URL.createObjectURL(pic.thumb));
        pics.push(pic);
      } catch {
        alert(`「${file.name}」读不出来，已跳过`);
      }
    }
    e.target.value = '';
    drawPics();
  };

  const batchSelect = form.elements.batchId;
  let picked = batchSelect.value;
  batchSelect.onchange = async () => {
    if (batchSelect.value === '+') {
      const b = await editBatch();
      if (b) batchSelect.insertAdjacentHTML('afterbegin', `<option value="${esc(b.id)}">${esc(b.name)}</option>`);
      batchSelect.value = b?.id ?? picked;
    }
    picked = batchSelect.value;
  };

  let saving = false;
  form.onsubmit = async e => {
    e.preventDefault();
    if (saving) return;
    saving = true;
    const f = new FormData(form);
    const str = name => f.get(name).trim();
    const next = {
      ...i,
      name: str('name'), category: str('category'), brand: str('brand'), era: str('era'), origin: str('origin'),
      condition: str('condition'), size: str('size'), notes: str('notes'), batchId: f.get('batchId'),
      price: +f.get('price') || 0, cost: +f.get('cost') || 0, extraCost: +f.get('extraCost') || 0,
      measures: Object.fromEntries(MEASURES.map(k => [k, str('m:' + k)]).filter(([, v]) => v)),
      photoIds: pics.map(p => p.id),
    };
    try {
      await commit(['items', 'photos', 'thumbs'], s => {
        s('items').put(next);
        pics.filter(p => p.full).forEach(p => { s('photos').put(p.full, p.id); s('thumbs').put(p.thumb, p.id); });
        gone.forEach(p => { s('photos').delete(p); s('thumbs').delete(p); });
      });
    } finally {
      saving = false;
    }
    location.replace(`#/item/${i.id}`);
  };
}

// ---------- 批次 ----------

function batchesView() {
  const sorted = [...batches].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  main.innerHTML = `
    <header><h1>批次</h1><button class="btn primary" data-act="add">＋ 新建</button></header>
    ${sorted.length ? '' : '<p class="muted">还没有批次。每次进货建一个批次，就能看到这一批花了多少、回了多少。</p>'}
    ${sorted.map(b => {
      const s = batchStats(b, items);
      const gap = s.returned - s.invested;
      return `
        <section class="panel" data-id="${esc(b.id)}">
          <h2>${esc(b.name)}</h2>
          <p class="muted">${esc([b.date, b.source].filter(Boolean).join(' · '))}</p>
          <p>${s.count} 件，已售 ${s.sold} 件</p>
          <p>总投入 ${yuan(s.invested)}${b.fee ? `（含整批杂费 ${yuan(b.fee)}）` : ''} · 已回款 ${yuan(s.returned)}</p>
          <progress value="${s.returned}" max="${s.invested || 1}" aria-label="回本进度"></progress>
          <p class="muted">${!s.count ? '这批还没有货' : gap >= 0 ? `已回本，多出 ${yuan(gap)}` : `还差 ${yuan(-gap)} 回本`}</p>
          <div class="actions">
            ${s.count ? '<button class="btn" data-act="open">看这批货</button>' : ''}
            <button class="btn" data-act="edit">编辑</button>
            ${s.count ? '' : '<button class="btn" data-act="del">删除</button>'}
          </div>
        </section>`;
    }).join('')}`;

  const of = b => batches.find(x => x.id === b.closest('section').dataset.id);
  Object.assign(acts, {
    async add() { if (await editBatch()) route(); },
    async edit(b) { if (await editBatch(of(b))) route(); },
    open(b) {
      Object.assign(filter, { q: '', status: '', category: '', brand: '', batchId: of(b).id });
      shown = PAGE;
      listY = 0;
      location.hash = '#/';
    },
    async del(b) {
      const batch = of(b);
      if (!confirm(`删除批次「${batch.name}」？`)) return;
      await commit(['batches'], s => s('batches').delete(batch.id));
      route();
    },
  });
}

// ---------- 统计 ----------

function statsView() {
  const stock = stockStats(items);
  const months = monthlyStats(items);
  const all = months.reduce((t, m) => ({ count: t.count + m.count, revenue: t.revenue + m.revenue, profit: t.profit + m.profit }),
    { count: 0, revenue: 0, profit: 0 });
  const tr = (label, m, cls = '') =>
    `<tr class="${cls}"><td>${esc(label)}</td><td>${m.count}</td><td>${yuan(m.revenue)}</td><td>${yuan(m.profit)}</td></tr>`;
  main.innerHTML = `
    <header><h1>统计</h1></header>
    <section class="panel">
      <h2>库存（在售 + 已预订）</h2>
      <p>${stock.count} 件</p>
      <p>进价合计 ${yuan(stock.cost)}</p>
      <p>标价合计 ${yuan(stock.price)}</p>
    </section>
    <section class="panel">
      <h2>销售</h2>
      ${months.length ? `<table>
        <tr><th>月份</th><th>件数</th><th>销售额</th><th>盈利</th></tr>
        ${months.map(m => tr(m.month, m)).join('')}
        ${tr('合计', all, 'total')}
      </table>
      <p class="muted">盈利 = 成交价 − 你承担的运费 − 进价 − 额外成本。整批杂费不在这里扣，见「批次」。</p>`
      : '<p class="muted">还没有售出记录。</p>'}
    </section>`;
}

// ---------- 设置 / 备份 ----------

async function makeBackup(btn, withPhotos) {
  btn.disabled = true;
  btn.textContent = '正在生成…';
  let photos = [];
  if (withPhotos) {
    const t = db.transaction(['photos', 'thumbs']);
    const [ids, fulls, thumbIds, thumbs] = await Promise.all([
      wait(t.objectStore('photos').getAllKeys()), wait(t.objectStore('photos').getAll()),
      wait(t.objectStore('thumbs').getAllKeys()), wait(t.objectStore('thumbs').getAll()),
    ]);
    const thumbOf = new Map(thumbIds.map((id, n) => [id, thumbs[n]]));
    photos = ids.map((id, n) => ({ id, full: fulls[n], thumb: thumbOf.get(id) ?? new Blob() }));
  }
  const blob = packBackup({ items, batches }, photos, withPhotos);
  const file = new File([blob], `diuvintage-${withPhotos ? '完整' : '数据'}备份-${today()}.diubak`, { type: 'application/octet-stream' });

  // 分两步：生成完再让店主点一次。Safari 只允许在点击的当下调起分享面板
  btn.disabled = false;
  btn.textContent = `已生成（${fileSize(file.size)}），点这里保存`;
  delete btn.dataset.act;
  btn.onclick = () => {
    const done = () => { localStorage.lastBackup = Date.now(); route(); };
    const download = () => {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      done();
    };
    if (navigator.canShare?.({ files: [file] })) {
      // 店主自己关掉分享面板（AbortError）不算备份过，也不用再弹下载
      navigator.share({ files: [file] }).then(done, e => { if (e.name !== 'AbortError') download(); });
    } else {
      download();
    }
  };
}

function settingsView() {
  const last = +localStorage.lastBackup;
  main.innerHTML = `
    <header><h1>设置</h1></header>
    <section class="panel">
      <h2>备份</h2>
      <p class="muted">所有数据只存在这部手机里。删除桌面图标或清除 Safari 网站数据都会清空库存，请定期备份，并把备份文件存到「文件」或发到微信。</p>
      <p>上次备份：${last ? new Date(last).toLocaleString() : '从未'}</p>
      <button class="btn primary wide" data-act="data">备份数据（不含照片，很快）</button>
      <button class="btn wide" data-act="full">完整备份（含照片）</button>
      <label class="btn wide">从备份恢复<input type="file" hidden></label>
    </section>
    <section class="panel">
      <h2>本机</h2>
      <p>${items.length} 件货，${batches.length} 个批次</p>
      <p id="disk" class="muted"></p>
    </section>`;

  Object.assign(acts, { data: b => makeBackup(b, false), full: b => makeBackup(b, true) });

  Promise.all([navigator.storage?.estimate?.(), navigator.storage?.persisted?.(), globalThis.caches?.keys()]).then(([est, kept, keys]) => {
    const el = main.querySelector('#disk');
    if (!el) return;
    el.textContent = [
      est && `已用 ${fileSize(est.usage)}`,
      kept ? '持久存储已开启' : '持久存储未开启（请从桌面图标打开使用）',
      `版本 ${keys?.join(' ') || '未缓存'}`,
    ].filter(Boolean).join(' · ');
  });

  main.querySelector('[type=file]').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let b;
    try { b = await unpackBackup(file); } catch (err) { return alert(err.message); }
    const what = `${b.items.length} 件货、${b.batches.length} 个批次` +
      (b.withPhotos ? `、${b.photos.length} 张照片` : '（不含照片，手机里现有的照片会保留）');
    if (!confirm(`这份备份生成于 ${new Date(b.exportedAt).toLocaleString()}，包含 ${what}。\n\n恢复会覆盖现在手机里的全部库存数据，确定吗？`)) return;
    // shortcut: 只恢复数据时不清理没人引用的旧照片，占点空间但不会丢图；需要回收空间时做一次完整备份再恢复
    await commit(['items', 'batches', 'photos', 'thumbs'], s => {
      s('items').clear();
      s('batches').clear();
      b.items.forEach(x => s('items').put(x));
      b.batches.forEach(x => s('batches').put(x));
      if (!b.withPhotos) return;
      s('photos').clear();
      s('thumbs').clear();
      b.photos.forEach(p => { s('photos').put(p.full, p.id); s('thumbs').put(p.thumb, p.id); });
    });
    urls.forEach(u => URL.revokeObjectURL(u));
    urls.clear();
    alert('已恢复');
    route();
  };
}

// ---------- 路由 ----------

const views = { '': listView, item: itemView, new: formView, edit: formView, batches: batchesView, stats: statsView, settings: settingsView };
let acts = {};
let viewUrls = [];
let current;

function route() {
  if (current === '') listY = scrollY;
  viewUrls.forEach(u => URL.revokeObjectURL(u));
  viewUrls = [];
  acts = {};
  const [name, arg] = location.hash.slice(2).split('/');
  current = views[name] ? name : '';
  const tab = ['batches', 'stats', 'settings'].includes(current) ? current : '';
  document.querySelectorAll('nav a').forEach(a =>
    (a.hash === `#/${tab}` ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  scrollTo(0, 0);
  views[current](arg);
}

main.onclick = e => {
  const b = e.target.closest('[data-act]');
  if (b) acts[b.dataset.act]?.(b);
};

localStorage.firstRun ??= Date.now();
navigator.storage?.persist?.();
navigator.serviceWorker?.register('sw.js');
await load();
addEventListener('hashchange', route);
route();
