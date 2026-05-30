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
  { value: 'コンビニ',       emoji: '🏬' },
  { value: 'その他',         emoji: '📦' },
];

const CATEGORY_VALUES = CATEGORIES.map(c => c.value);

// Google Places の type → 当アプリのカテゴリ（優先順位順）
const PLACES_TYPE_MAP = [
  { types: ['supermarket', 'grocery_store'],          category: 'スーパー'       },
  { types: ['pharmacy', 'drugstore'],                  category: '薬局'           },
  { types: ['hardware_store', 'home_goods_store'],     category: 'ホームセンター' },
  { types: ['convenience_store'],                      category: 'コンビニ'       },
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

選択肢: スーパー, 薬局, ホームセンター, コンビニ, その他

JSON配列のみを返してください（他の文字は不要）。

例:
- 「牛乳」→ ["スーパー", "コンビニ"]
- 「絆創膏」→ ["薬局", "コンビニ"]
- 「ラップ」→ ["スーパー", "ホームセンター", "コンビニ"]
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
    <button onclick="clearActiveStore()">解除</button>
  `;
}

// --- Form: APIキー有無で表示切替 ---

function syncFormUI() {
  const hasKey = !!getApiKey();
  document.getElementById('category-select-wrap').classList.toggle('hidden', hasKey);
  document.getElementById('ai-indicator').classList.toggle('hidden', !hasKey);
}

// --- Render ---

function render() {
  const container = document.getElementById('lists-container');
  container.innerHTML = '';

  if (items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div style="font-size:48px">🛒</div>
        <p>商品を追加してください</p>
      </div>`;
    return;
  }

  const sorted = activeStore
    ? [...CATEGORIES.filter(c => c.value === activeStore), ...CATEGORIES.filter(c => c.value !== activeStore)]
    : CATEGORIES;

  sorted.forEach(({ value, emoji }) => {
    const catItems = items.filter(i => i.categories.includes(value));
    if (catItems.length === 0) return;

    const isActive = value === activeStore;
    const section  = document.createElement('div');
    section.className = `category-section${isActive ? ' active-store' : ''}`;

    const hereBadge = isActive ? '<span class="here-badge">📍 ここ</span>' : '';
    section.innerHTML = `
      <div class="category-header">
        <h2>${escapeHtml(emoji)} ${escapeHtml(value)} ${hereBadge}</h2>
        <span class="category-count">${catItems.length}点</span>
      </div>
      <ul class="item-list"></ul>`;

    const ul = section.querySelector('.item-list');

    catItems.forEach(item => {
      const li = document.createElement('li');

      const nameEl = document.createElement('span');
      nameEl.className = 'item-name';
      nameEl.textContent = item.name;

      const otherCats = item.categories.filter(c => c !== value);
      const badgesEl  = document.createElement('span');
      badgesEl.className = 'cat-badges';
      otherCats.forEach(c => {
        const cat   = CATEGORIES.find(x => x.value === c);
        const badge = document.createElement('span');
        badge.className   = 'cat-badge';
        badge.textContent = `${cat.emoji} ${c}`;
        badgesEl.appendChild(badge);
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'delete-btn';
      delBtn.textContent = '✕';
      delBtn.setAttribute('aria-label', '削除');
      delBtn.addEventListener('click', () => {
        if (confirm(`「${item.name}」を削除しますか？`)) deleteItem(item.id);
      });

      li.appendChild(nameEl);
      if (otherCats.length) li.appendChild(badgesEl);
      li.appendChild(delBtn);
      ul.appendChild(li);
    });

    container.appendChild(section);
  });
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

// --- Init ---
syncFormUI();
renderLocationBanner();
render();
