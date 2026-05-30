'use strict';

// --- Firebase ---

firebase.initializeApp({
  apiKey:            "AIzaSyARAEi3bziwHcse4AirSci-mBr18_BKH2I",
  authDomain:        "kaimono-app-e830b.firebaseapp.com",
  projectId:         "kaimono-app-e830b",
  storageBucket:     "kaimono-app-e830b.firebasestorage.app",
  messagingSenderId: "882067349627",
  appId:             "1:882067349627:web:40d8d298c731b65ced82de",
});

const db       = firebase.firestore();
const itemsRef = db.collection('items');

// --- Constants ---

const STORAGE_KEY      = 'kaimono_items';
const API_KEY_STORAGE  = 'kaimono_google_api_key';
const ACTIVE_STORE_KEY = 'kaimono_active_store';
const RATE_LIMIT_KEY   = 'kaimono_places_rate';
const GEMINI_MODEL     = 'gemini-2.5-flash';

// 1日あたりの Places API 呼び出し上限・クールダウン
const DAILY_LIMIT   = 30;
const COOLDOWN_MS   = 60_000; // 1分

const CATEGORIES = [
  { value: 'スーパー',       emoji: '🏪' },
  { value: '薬局',           emoji: '💊' },
  { value: 'ホームセンター', emoji: '🔨' },
  { value: 'その他',         emoji: '📦' },
];

const CATEGORY_VALUES = CATEGORIES.map(c => c.value);

// Google Places の type → 当アプリのカテゴリ（優先順位順）
const PLACES_TYPE_MAP = [
  { types: ['supermarket', 'grocery_store'],          category: 'スーパー'       },
  { types: ['pharmacy', 'drugstore'],                  category: '薬局'           },
  { types: ['hardware_store', 'home_goods_store'],     category: 'ホームセンター' },
];

const ALL_PLACES_TYPES = PLACES_TYPE_MAP.flatMap(m => m.types);

// --- Storage helpers (localStorage は APIキー・店舗設定のみ残す) ---

function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}

// --- Rate limiter (Places API 暴走防止) ---

function checkRateLimit() {
  const today = new Date().toDateString();
  const r = JSON.parse(localStorage.getItem(RATE_LIMIT_KEY) || '{}');

  if (r.date !== today) { r.date = today; r.count = 0; } // 日付が変わったらリセット

  if (Date.now() - (r.lastCall ?? 0) < COOLDOWN_MS) return false; // クールダウン中
  if (r.count >= DAILY_LIMIT) return false;                        // 1日の上限

  r.count++;
  r.lastCall = Date.now();
  localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(r));
  return true;
}

// --- App state ---

let items       = [];
let activeStore = localStorage.getItem(ACTIVE_STORE_KEY) || null;
let activeTab   = '全部';
let isAdding    = false;

// Firestoreからリアルタイムで同期
itemsRef.orderBy('createdAt').onSnapshot(snapshot => {
  items = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
    categories: doc.data().categories ?? ['その他'],
  }));
  render();
});

// --- Item management ---

async function addItem(name, categories) {
  await itemsRef.add({
    name:      name.trim(),
    categories,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

async function deleteItem(id) {
  await itemsRef.doc(id).delete();
}

// --- Active store ---

function setActiveStore(store) {
  activeStore = store;
  if (store) {
    localStorage.setItem(ACTIVE_STORE_KEY, store);
  } else {
    localStorage.removeItem(ACTIVE_STORE_KEY);
  }
  renderLocationBanner();
  render();
}

function clearActiveStore() {
  setActiveStore(null);
  document.getElementById('location-banner').className = 'hidden';
}

// --- Gemini API: カテゴリ自動判定 ---

async function categorizeWithGemini(name) {
  const key = getApiKey();
  if (!key) return null;

  const prompt = `あなたは日本の買い物アシスタントです。
商品名を見て、どの店舗カテゴリで買えるか、該当するものをすべて選んでください。

商品名: 「${name}」

選択肢: スーパー, 薬局, ホームセンター, その他

JSON配列のみを返してください（他の文字は不要）。

例:
- 「牛乳」→ ["スーパー"]
- 「絆創膏」→ ["薬局"]
- 「ラップ」→ ["スーパー", "ホームセンター"]
- 「釘」→ ["ホームセンター"]`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 500 },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `HTTP ${res.status}`);
  }

  const data = await res.json();
  const text  = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
  const match = text.match(/\[[\s\S]*?\]/);
  const parsed = JSON.parse(match?.[0] ?? '["その他"]');
  const valid  = parsed.filter(c => CATEGORY_VALUES.includes(c));
  return valid.length > 0 ? valid : ['その他'];
}

// --- Google Places API: 近くの店舗を検出 ---

async function detectLocation() {
  const btn = document.getElementById('location-btn');
  btn.textContent = '⏳';
  btn.disabled = true;

  try {
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 })
    );
    const { latitude: lat, longitude: lng } = pos.coords;
    const store = await queryNearestStore(lat, lng);

    if (store) {
      setActiveStore(store);
    } else {
      showLocationError('近くに対応店舗が見つかりませんでした');
    }
  } catch (err) {
    const msg = err.code === 1
      ? '位置情報の許可が必要です'
      : '位置情報の取得に失敗しました';
    showLocationError(msg);
  } finally {
    btn.textContent = '📍';
    btn.disabled = false;
  }
}

async function queryNearestStore(lat, lng) {
  const key = getApiKey();
  if (!key) {
    showLocationError('API キーを設定してください');
    return null;
  }

  if (!checkRateLimit()) {
    showLocationError('しばらく待ってから再試行してください');
    return null;
  }

  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.types',
    },
    body: JSON.stringify({
      includedTypes: ALL_PLACES_TYPES,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: 500,
        },
      },
      maxResultCount: 10,
      rankPreference: 'DISTANCE',
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `Places API error ${res.status}`);
  }

  const data = await res.json();
  if (!data.places?.length) return null;

  // 最近傍の店舗（rankPreference: DISTANCE で先頭が最近傍）
  for (const place of data.places) {
    const types = place.types ?? [];
    for (const { types: mapTypes, category } of PLACES_TYPE_MAP) {
      if (mapTypes.some(t => types.includes(t))) return category;
    }
  }

  return null;
}

function showLocationError(msg) {
  const banner = document.getElementById('location-banner');
  banner.className = 'location-banner error';
  banner.innerHTML = `<span>⚠️ ${escapeHtml(msg)}</span><button onclick="clearActiveStore()">閉じる</button>`;
}

// --- Location banner ---

function renderLocationBanner() {
  const banner = document.getElementById('location-banner');
  if (!activeStore) { banner.className = 'hidden'; return; }
  const cat = CATEGORIES.find(c => c.value === activeStore);
  banner.className = 'location-banner active';
  banner.innerHTML = `
    <span>${cat.emoji} <strong>${escapeHtml(activeStore)}</strong> 付近にいます</span>
    <div class="banner-actions">
      <button onclick="switchToStoreTab()">切り替え</button>
      <button onclick="clearActiveStore()">解除</button>
    </div>
  `;
}

function switchToStoreTab() {
  if (activeStore) {
    activeTab = activeStore;
    render();
  }
}

// --- Form: APIキー有無で表示切替 ---

function syncFormUI() {
  const hasKey = !!getApiKey();
  document.getElementById('category-select-wrap').classList.toggle('hidden', hasKey);
  document.getElementById('ai-indicator').classList.toggle('hidden', !hasKey);
}

// --- Tag Edit Modal ---

function openEditModal(item) {
  const modal   = document.getElementById('edit-modal');
  const title   = document.getElementById('edit-modal-title');
  const tagList = document.getElementById('edit-tag-list');

  title.textContent = `「${item.name}」のタグを編集`;
  tagList.innerHTML = '';

  CATEGORIES.forEach(cat => {
    const label = document.createElement('label');
    label.className = 'tag-checkbox-row';
    const checked = item.categories.includes(cat.value);
    label.innerHTML = `
      <input type="checkbox" value="${escapeHtml(cat.value)}" ${checked ? 'checked' : ''}>
      <span>${cat.emoji} ${escapeHtml(cat.value)}</span>
    `;
    tagList.appendChild(label);
  });

  modal.classList.remove('hidden');

  document.getElementById('edit-cancel-btn').onclick = () => modal.classList.add('hidden');
  document.querySelector('.modal-overlay').onclick    = () => modal.classList.add('hidden');

  document.getElementById('edit-save-btn').onclick = async () => {
    const checked = [...tagList.querySelectorAll('input:checked')].map(cb => cb.value);
    await itemsRef.doc(item.id).update({ categories: checked.length ? checked : ['その他'] });
    modal.classList.add('hidden');
  };
}

// --- Render ---

function addLongPress(el, callback) {
  let timer;
  el.addEventListener('touchstart', () => { timer = setTimeout(callback, 500); }, { passive: true });
  el.addEventListener('touchend',   () => clearTimeout(timer), { passive: true });
  el.addEventListener('touchmove',  () => clearTimeout(timer), { passive: true });
  el.addEventListener('dblclick', callback);
}

function addSwipeDelete(li, item) {
  let startX = 0;
  let startY = 0;
  let deltaX = 0;
  let tracking = false;

  li.addEventListener('touchstart', e => {
    startX  = e.touches[0].clientX;
    startY  = e.touches[0].clientY;
    deltaX  = 0;
    tracking = false;
    li.style.transition = 'none';
  }, { passive: true });

  li.addEventListener('touchmove', e => {
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!tracking && Math.abs(dx) > Math.abs(dy) && dx > 8) tracking = true;
    if (!tracking) return;
    deltaX = Math.max(0, dx);
    li.style.transform = `translateX(${deltaX}px)`;
    li.style.opacity   = String(Math.max(0, 1 - deltaX / 150));
  }, { passive: true });

  li.addEventListener('touchend', () => {
    if (deltaX > 80) {
      li.style.transition = 'transform 0.15s ease, opacity 0.15s ease';
      li.style.transform  = 'translateX(120%)';
      li.style.opacity    = '0';
      setTimeout(() => {
        li.style.transition  = 'max-height 0.15s ease, padding 0.15s ease';
        li.style.maxHeight   = li.offsetHeight + 'px';
        li.style.overflow    = 'hidden';
        requestAnimationFrame(() => {
          li.style.maxHeight = '0';
          li.style.padding   = '0';
          li.style.borderBottom = 'none';
        });
        setTimeout(() => deleteItem(item.id), 150);
      }, 150);
    } else {
      li.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
      li.style.transform  = '';
      li.style.opacity    = '';
    }
    deltaX = 0;
  });
}

function createItemEl(item, hiddenCategory) {
  const li = document.createElement('li');

  const nameEl = document.createElement('span');
  nameEl.className = 'item-name';
  nameEl.textContent = item.name;

  const badgesEl = document.createElement('span');
  badgesEl.className = 'cat-badges';
  item.categories
    .filter(c => c !== hiddenCategory)
    .forEach(c => {
      const cat = CATEGORIES.find(x => x.value === c);
      if (!cat) return;
      const badge = document.createElement('span');
      badge.className = 'cat-badge';
      badge.textContent = cat.emoji;
      badgesEl.appendChild(badge);
    });

  const delBtn = document.createElement('button');
  delBtn.className = 'delete-btn';
  delBtn.textContent = '✕';
  delBtn.setAttribute('aria-label', '削除');
  delBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (confirm(`「${item.name}」を削除しますか？`)) deleteItem(item.id);
  });

  const row = document.createElement('div');
  row.className = 'item-row';
  row.appendChild(nameEl);
  row.appendChild(delBtn);
  li.appendChild(row);
  if (badgesEl.children.length > 0) li.appendChild(badgesEl);

  addLongPress(li, () => openEditModal(item));
  addSwipeDelete(li, item);

  return li;
}

function makeSection(title, itemList, className = '') {
  const section = document.createElement('div');
  section.className = `category-section${className ? ' ' + className : ''}`;
  section.innerHTML = `
    <div class="category-header">
      <h2>${title}</h2>
      <span class="category-count">${itemList.length}点</span>
    </div>
    <ul class="item-list"></ul>`;
  return section;
}

function render() {
  const container = document.getElementById('lists-container');
  container.innerHTML = '';

  // タブの見た目を更新
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === activeTab);
  });

  const filtered = activeTab === '全部'
    ? items
    : items.filter(i => i.categories.includes(activeTab));

  if (filtered.length === 0) {
    const msg = activeTab === '全部' ? '商品を追加してください' : `${activeTab}の商品はありません`;
    container.innerHTML = `
      <div class="empty-state">
        <div style="font-size:48px">🛒</div>
        <p>${msg}</p>
      </div>`;
    return;
  }

  const hiddenCat = activeTab === '全部' ? null : activeTab;
  const isNearThisStore = activeStore && activeStore === activeTab;
  const cat = CATEGORIES.find(c => c.value === activeTab);

  const title = activeTab === '全部'
    ? '🛒 買い物リスト'
    : `${cat.emoji} ${escapeHtml(activeTab)}${isNearThisStore ? ' <span class="here-badge">📍 ここ</span>' : ''}`;

  const section = makeSection(title, filtered, isNearThisStore ? 'active-store' : '');
  const ul = section.querySelector('.item-list');
  filtered.forEach(item => ul.appendChild(createItemEl(item, hiddenCat)));
  container.appendChild(section);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Event listeners ---

document.getElementById('settings-btn').addEventListener('click', () => {
  const panel = document.getElementById('settings-panel');
  const isHidden = panel.classList.toggle('hidden');
  if (!isHidden) document.getElementById('api-key-input').value = getApiKey();
});

document.getElementById('save-key-btn').addEventListener('click', () => {
  const key = document.getElementById('api-key-input').value.trim();
  localStorage.setItem(API_KEY_STORAGE, key);
  syncFormUI();
  document.getElementById('settings-panel').classList.add('hidden');
  const btn = document.getElementById('save-key-btn');
  btn.textContent = '✓ 保存';
  setTimeout(() => { btn.textContent = '保存'; }, 2000);
});

document.getElementById('location-btn').addEventListener('click', detectLocation);

document.getElementById('add-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (isAdding) return;

  const input  = document.getElementById('item-input');
  const name   = input.value.trim();
  if (!name) return;

  const addBtn = document.getElementById('add-btn');
  const hasKey = !!getApiKey();
  let categories;

  if (hasKey) {
    isAdding = true;
    addBtn.textContent = '判定中…';
    addBtn.disabled    = true;

    try {
      categories = await categorizeWithGemini(name) ?? ['その他'];
    } catch {
      categories = ['その他'];
    } finally {
      addBtn.textContent = '追加';
      addBtn.disabled    = false;
      isAdding           = false;
    }
  } else {
    categories = [document.getElementById('category-select').value];
  }

  addItem(name, categories);
  input.value = '';
  input.focus();
});

// --- Bottom tabs ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    render();
  });
});

// --- Init ---
syncFormUI();
renderLocationBanner();
render();
