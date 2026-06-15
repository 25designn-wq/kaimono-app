'use strict';

// ===== Firebase =====
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
const TS        = firebase.firestore.FieldValue.serverTimestamp;

// ===== 緊急度 =====
const URGENCY = {
  anytime: { factor: 1.0, color: [92, 156, 200],  text: '#ffffff' }, // 青
  soon:    { factor: 1.3, color: [224, 168, 64],   text: '#2a2410' }, // 黄
  hurry:   { factor: 1.6, color: [214, 78, 64],    text: '#ffffff' }, // 赤
};
const urgencyOf = item => (URGENCY[item.urgency] ? item.urgency : 'anytime');

// ===== サイズ（リストの数で画面を埋める）=====
const FILL  = 0.52;   // 画面に対する泡の総面積の割合
const R_MIN = 44;     // 最小半径（5文字が収まる下限）
const R_MAX = 120;    // 最大半径

// 緊急度で重み付けしつつ、総面積が画面の FILL 割合になるよう各半径を決める
function recomputeSizes() {
  const arr = [...bubbles.values()];
  if (!arr.length) return;
  let sumW = 0;
  for (const b of arr) sumW += URGENCY[urgencyOf(b.item)].factor;
  const fillArea = FILL * stageW * stageH;
  for (const b of arr) {
    const w = URGENCY[urgencyOf(b.item)].factor;
    let r = Math.sqrt((fillArea * w / sumW) / Math.PI);
    r = Math.max(R_MIN, Math.min(R_MAX, r));
    const old = b.body.plugin.r;
    if (Math.abs(r - old) > 0.5) {
      Body.scale(b.body, r / old, r / old);
      b.body.plugin.r = r;
    }
  }
}

// ===== Matter（物理のみ）=====
const { Engine, Runner, World, Bodies, Body, Query, Events } = Matter;

const stage = document.getElementById('bubble-stage');
let stageW = stage.clientWidth;
let stageH = stage.clientHeight;
let dpr    = Math.min(window.devicePixelRatio || 1, 2);

const engine = Engine.create();
engine.gravity.scale = 0;
const runner = Runner.create();
Runner.run(runner, engine);

let walls = [];
function buildWalls() {
  if (walls.length) World.remove(engine.world, walls);
  const t = 120, opt = { isStatic: true };
  walls = [
    Bodies.rectangle(stageW / 2, -t / 2, stageW + t * 2, t, opt),
    Bodies.rectangle(stageW / 2, stageH + t / 2, stageW + t * 2, t, opt),
    Bodies.rectangle(-t / 2, stageH / 2, t, stageH + t * 2, opt),
    Bodies.rectangle(stageW + t / 2, stageH / 2, t, stageH + t * 2, opt),
  ];
  World.add(engine.world, walls);
}

// ===== フォームシェーダー（画面全体を1枚で描く泡）=====
const URG_IDX = { anytime: 0, soon: 1, hurry: 2 };
const urgencyIndex = item => URG_IDX[urgencyOf(item)];

const glCanvas = document.createElement('canvas');
glCanvas.id = 'gl';
stage.appendChild(glCanvas);

const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: false });
renderer.setPixelRatio(dpr);
renderer.setClearColor(0x000000, 0);

const scene  = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const MAX_B = 48;
const foamUniforms = {
  uTime:    { value: 0 },
  uCount:   { value: 0 },
  uBubbles: { value: Array.from({ length: MAX_B }, () => new THREE.Vector4(0, 0, 0, 0)) }, // x,y,r,colorIdx（device px・y上向き）
  uColors:  { value: [
    new THREE.Vector3(URGENCY.anytime.color[0]/255, URGENCY.anytime.color[1]/255, URGENCY.anytime.color[2]/255),
    new THREE.Vector3(URGENCY.soon.color[0]/255,    URGENCY.soon.color[1]/255,    URGENCY.soon.color[2]/255),
    new THREE.Vector3(URGENCY.hurry.color[0]/255,   URGENCY.hurry.color[1]/255,   URGENCY.hurry.color[2]/255),
  ] },
};

const FOAM_FRAG = `
  precision highp float;
  #define MAX_B ${MAX_B}
  uniform float uTime;
  uniform int   uCount;
  uniform vec4  uBubbles[MAX_B];   // x,y,r,colorIdx（device px・y上向き）
  uniform vec3  uColors[3];

  vec3 irid(float t){ return 0.5 + 0.5*cos(6.28318*(t + vec3(0.0,0.33,0.67))); }

  void main(){
    vec2 p = gl_FragCoord.xy;

    float best = 1e20, second = 1e20;
    vec2  bestC = vec2(0.0); float bestR = 1.0; int bestIdx = 0;
    for (int i = 0; i < MAX_B; i++) {
      if (i >= uCount) break;
      vec4 b = uBubbles[i];
      vec2 d = p - b.xy;
      float pd = dot(d, d) - b.z * b.z;          // パワー距離
      if (pd < best) { second = best; best = pd; bestC = b.xy; bestR = b.z; bestIdx = int(b.w); }
      else if (pd < second) { second = pd; }
    }

    vec2 o = p - bestC;
    float lr2 = dot(o, o);
    float len = sqrt(lr2);
    float sd = bestR - len;                       // >0 で円の内側
    float cover = smoothstep(-1.5, 1.5, sd);
    if (cover <= 0.001) discard;

    float inside = max(bestR*bestR - lr2, 0.0);
    float h = sqrt(inside);
    float edge = second - best;                   // radical軸付近で0＝膜
    float flatness = smoothstep(0.0, bestR*bestR*0.5, edge);
    h *= flatness;                                 // 膜の近くは平らに
    vec3 n = normalize(vec3(o / bestR, (h + 0.001) / bestR));

    float ndv = abs(n.z);
    float f = pow(1.0 - ndv, 3.0);

    vec3 base = uColors[0];
    if (bestIdx == 1) base = uColors[1];
    else if (bestIdx == 2) base = uColors[2];

    vec3 iri = irid(n.x*0.30 + n.y*0.22 + uTime*0.03);
    vec3 L = normalize(vec3(-0.4, 0.6, 0.85));
    float spec = pow(max(dot(reflect(-L, n), vec3(0.0,0.0,1.0)), 0.0), 42.0);

    vec3 col = base;
    col = mix(col, col*1.25, f*0.5);
    col += iri * f * 0.5;
    col += vec3(1.0) * spec;

    // プラトー境界（膜の線）：暗いふち＋内側に明るい張り
    float border = 1.0 - smoothstep(0.0, bestR*bestR*0.16, edge);
    col = mix(col, col*0.6, border*0.55);                 // 境界を暗く
    float rib = smoothstep(0.0, bestR*bestR*0.05, edge) - smoothstep(bestR*bestR*0.05, bestR*bestR*0.18, edge);
    col += vec3(0.25) * rib;                              // 膜のすぐ内側を明るく

    float alpha = (0.6 + f*0.38 + spec) * cover;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

const foamMat = new THREE.ShaderMaterial({
  uniforms: foamUniforms,
  vertexShader: `void main(){ gl_Position = vec4(position, 1.0); }`,
  fragmentShader: FOAM_FRAG,
  transparent: true, depthTest: false, depthWrite: false,
});
const foamMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), foamMat);
foamMesh.frustumCulled = false;
scene.add(foamMesh);

// ===== 文字・粒子の2Dオーバーレイ =====
const overlay = document.createElement('canvas');
overlay.id = 'overlay';
stage.appendChild(overlay);
const octx = overlay.getContext('2d');

function resizeStage() {
  stageW = stage.clientWidth;
  stageH = stage.clientHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);

  renderer.setPixelRatio(dpr);
  renderer.setSize(stageW, stageH);

  overlay.width = stageW * dpr;
  overlay.height = stageH * dpr;
  overlay.style.width = stageW + 'px';
  overlay.style.height = stageH + 'px';
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);

  buildWalls();
  recomputeSizes();
}
window.addEventListener('resize', resizeStage);

// ===== バブル管理 =====
const bubbles = new Map(); // id -> { body, item, mesh }

function makeBubble(item) {
  const r = 60; // 仮。直後の recomputeSizes() で調整される
  const x = 40 + Math.random() * Math.max(stageW - 80, 1);
  const y = 40 + Math.random() * Math.max(stageH - 80, 1);

  const body = Bodies.circle(x, y, r, {
    restitution: 0.18, friction: 0, frictionAir: 0.075, density: 0.0011, slop: 0.8,
  });
  body.plugin = { id: item.id, item, r, wobble: 0, phase: Math.random() * Math.PI * 2 };
  Body.setVelocity(body, { x: (Math.random() - 0.5) * 0.8, y: (Math.random() - 0.5) * 0.8 });
  World.add(engine.world, body);

  bubbles.set(item.id, { body, item });
}

function removeBubble(id, withPop) {
  const b = bubbles.get(id);
  if (!b) return;
  if (withPop) spawnParticles(b.body.position.x, b.body.position.y, URGENCY[urgencyOf(b.item)].color, b.body.plugin.r);
  World.remove(engine.world, b.body);
  bubbles.delete(id);
}

function syncBubbles(activeItems) {
  const ids = new Set(activeItems.map(i => i.id));
  for (const id of [...bubbles.keys()]) if (!ids.has(id)) removeBubble(id, false);
  for (const item of activeItems) if (!bubbles.has(item.id)) makeBubble(item);
  recomputeSizes();
  document.getElementById('empty-hint').classList.toggle('hidden', activeItems.length > 0);
}

// ===== ふわふわ＋凝集＋傾き =====
let tiltX = 0, tiltY = 0;
Events.on(engine, 'beforeUpdate', () => {
  const list = [...bubbles.values()].map(b => b.body);

  for (const body of list) {
    const m = body.mass, p = body.plugin;
    p.phase += 0.008;
    const wanderX = Math.cos(p.phase) * 0.00005;
    const wanderY = Math.sin(p.phase * 0.8) * 0.00005;
    const cx = (stageW / 2 - body.position.x) * 0.0000020;
    const cy = (stageH / 2 - body.position.y) * 0.0000020;
    Body.applyForce(body, body.position, {
      x: (wanderX + cx + tiltX * 0.00040) * m,
      y: (wanderY + cy + tiltY * 0.00040) * m,
    });
  }

  // 石鹸の泡どうしがくっつく：近いと弱い引力（揺れが大きいと離れる）
  const shaking = Math.hypot(tiltX, tiltY) > 0.6;
  for (let i = 0; i < list.length && !shaking; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const dx = b.position.x - a.position.x, dy = b.position.y - a.position.y;
      const d = Math.hypot(dx, dy) || 0.0001;
      if (d < a.plugin.r + b.plugin.r + 30) {
        const f = 0.0000010, fx = (dx / d) * f, fy = (dy / d) * f;
        Body.applyForce(a, a.position, { x:  fx * a.mass, y:  fy * a.mass });
        Body.applyForce(b, b.position, { x: -fx * b.mass, y: -fy * b.mass });
      }
    }
  }

  for (const body of list) {
    const sp = Math.hypot(body.velocity.x, body.velocity.y), cap = 1.1;
    if (sp > cap) Body.setVelocity(body, { x: body.velocity.x / sp * cap, y: body.velocity.y / sp * cap });
    body.plugin.wobble *= 0.90;
  }
});

Events.on(engine, 'collisionStart', e => {
  for (const pair of e.pairs) {
    const a = pair.bodyA.plugin, b = pair.bodyB.plugin;
    const impact = Math.min((pair.collision?.depth || 1) * 0.05 + 0.12, 0.26);
    if (a && bubbles.has(a.id)) a.wobble = Math.max(a.wobble, impact);
    if (b && bubbles.has(b.id)) b.wobble = Math.max(b.wobble, impact);
  }
});

// ===== 粒子（弾ける）=====
const particles = [];
function spawnParticles(x, y, color, r) {
  for (let i = 0; i < 16; i++) {
    const a = (Math.PI * 2 * i) / 16 + Math.random() * 0.4;
    const sp = 3 + Math.random() * 4.5;
    particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, size: 2 + Math.random() * (r / 14), color });
  }
}

// ===== 描画ループ =====
function frame() {
  const now = performance.now();

  // フォーム：物理 → シェーダーuniforms（device px・y上向き）
  let bi = 0;
  for (const { body, item } of bubbles.values()) {
    if (bi >= MAX_B) break;
    foamUniforms.uBubbles.value[bi].set(
      body.position.x * dpr,
      (stageH - body.position.y) * dpr,
      body.plugin.r * 1.2 * dpr,   // 描画は少し大きく＝隣と重なって膜ができる
      urgencyIndex(item)
    );
    bi++;
  }
  foamUniforms.uCount.value = bi;
  foamUniforms.uTime.value = now / 1000;
  renderer.render(scene, camera);

  // 2D：文字・粒子
  octx.clearRect(0, 0, stageW, stageH);
  for (const { body, item } of bubbles.values()) {
    const r = body.plugin.r;
    const u = URGENCY[urgencyOf(item)];
    const { x, y } = body.position;
    const text = item.name;
    const FONT = px => `600 ${px}px -apple-system, "Hiragino Sans", sans-serif`;
    const maxW = r * 1.55;

    // フォント：最低5文字が必ず収まるサイズに調整
    let fontSize = Math.min(r * 0.42, 26);
    octx.font = FONT(fontSize);
    const probe  = text.slice(0, 5) || text;
    const probeW = octx.measureText(probe).width;
    if (probeW > maxW) fontSize *= maxW / probeW;
    fontSize = Math.max(fontSize, 11);
    octx.font = FONT(fontSize);

    const fullW = octx.measureText(text).width;
    const curv  = 0.42 / r; // 泡に沿った湾曲

    octx.save();
    octx.beginPath();
    octx.arc(x, y, r * 0.9, 0, Math.PI * 2);
    octx.clip();
    octx.fillStyle = u.text;
    octx.textBaseline = 'middle';
    octx.textAlign = 'center';
    octx.shadowColor = 'rgba(0,0,0,0.22)';
    octx.shadowBlur = 3;

    const drawCurved = startX => {
      let gx = startX;
      for (const ch of text) {
        const cw = octx.measureText(ch).width;
        const cxp = gx + cw / 2;
        const dx = cxp - x;
        const yy = y + curv * dx * dx;            // 湾曲（下に弧）
        const rot = Math.atan(2 * curv * dx);     // 接線方向に回転
        octx.save();
        octx.translate(cxp, yy);
        octx.rotate(rot);
        octx.fillText(ch, 0, 0);
        octx.restore();
        gx += cw;
      }
    };

    if (fullW <= maxW) {
      drawCurved(x - fullW / 2);
    } else {
      const span = fullW + 40;
      const offset = (now / 22) % span;
      drawCurved(x - maxW / 2 - offset);
      drawCurved(x - maxW / 2 - offset + span);
    }
    octx.restore();
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.vy += 0.10; p.vx *= 0.985; p.vy *= 0.985; p.life -= 0.028;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    const a = Math.max(p.life, 0);
    const rad = p.size * (0.8 + (1 - p.life) * 1.6);   // 飛びながら広がる
    octx.save();
    // 柔らかいしずく（中心が明るく外へ透明）
    const g = octx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
    g.addColorStop(0,   `rgba(255,255,255,${0.7 * a})`);
    g.addColorStop(0.4, `rgba(${p.color[0]},${p.color[1]},${p.color[2]},${0.55 * a})`);
    g.addColorStop(1,   `rgba(${p.color[0]},${p.color[1]},${p.color[2]},0)`);
    octx.fillStyle = g;
    octx.beginPath();
    octx.arc(p.x, p.y, rad, 0, Math.PI * 2);
    octx.fill();
    octx.restore();
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ===== タップで弾ける（オーバーレイが最前面）=====
overlay.addEventListener('pointerdown', e => {
  if (!urgencyPop.classList.contains('hidden')) { closeUrgencyPop(); return; }
  const rect = overlay.getBoundingClientRect();
  const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const hit = Query.point([...bubbles.values()].map(b => b.body), pt)[0];
  if (hit) { removeBubble(hit.plugin.id, true); markBought(hit.plugin.id); }
});

// ===== Firestore CRUD =====
async function addItem(name, urgency) {
  await itemsRef.add({ name: name.trim(), urgency, bought: false, createdAt: TS() });
}
async function markBought(id) {
  try { await itemsRef.doc(id).update({ bought: true, boughtAt: TS() }); } catch (e) {}
}
async function undoBought(id) {
  await itemsRef.doc(id).update({ bought: false });
}

// ===== 同期 =====
let recentItems = [];
itemsRef.onSnapshot(snap => {
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  syncBubbles(all.filter(i => !i.bought));
  recentItems = all
    .filter(i => i.bought)
    .sort((a, b) => (b.boughtAt?.toMillis?.() || 0) - (a.boughtAt?.toMillis?.() || 0))
    .slice(0, 10);
  if (!document.getElementById('recent-panel').classList.contains('hidden')) renderRecent();
});

// ===== 入力（＋ → 緊急度ポップ → 登録）=====
const urgencyPop = document.getElementById('urgency-pop');
const itemInput  = document.getElementById('item-input');
let pendingName  = null;

function openUrgencyPop(name) {
  pendingName = name;
  const popName = document.getElementById('pop-name');
  popName.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = name;
  popName.appendChild(strong);
  popName.appendChild(document.createTextNode(' はどれくらい？'));
  urgencyPop.classList.remove('hidden');
}
function closeUrgencyPop() {
  urgencyPop.classList.add('hidden');
  pendingName = null;
}

document.getElementById('add-form').addEventListener('submit', e => {
  e.preventDefault();
  const name = itemInput.value.trim();
  if (!name) return;
  itemInput.blur();
  openUrgencyPop(name);
});
document.querySelectorAll('.urgency-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    if (!pendingName) return;
    addItem(pendingName, opt.dataset.urgency);
    itemInput.value = '';
    closeUrgencyPop();
  });
});

// ===== 最近買ったもの =====
const recentPanel = document.getElementById('recent-panel');
function renderRecent() {
  const ul = document.getElementById('recent-list');
  ul.innerHTML = '';
  if (recentItems.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'まだありません';
    ul.appendChild(li);
    return;
  }
  for (const item of recentItems) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = item.name;
    const btn = document.createElement('button');
    btn.textContent = '戻す';
    btn.addEventListener('click', () => undoBought(item.id));
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  }
}
document.getElementById('recent-btn').addEventListener('click', () => {
  renderRecent();
  recentPanel.classList.remove('hidden');
});
document.getElementById('recent-close').addEventListener('click', () => recentPanel.classList.add('hidden'));
document.querySelector('.panel-overlay').addEventListener('click', () => recentPanel.classList.add('hidden'));

// ===== 傾き =====
let tiltEnabled = false;
function handleOrientation(ev) {
  tiltX = Math.max(-1, Math.min(1, (ev.gamma || 0) / 45));
  tiltY = Math.max(-1, Math.min(1, (ev.beta || 0) / 45));
}
function enableTilt() {
  if (tiltEnabled) return;
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then(s => {
      if (s === 'granted') { window.addEventListener('deviceorientation', handleOrientation); tiltEnabled = true; }
    }).catch(() => {});
  } else if ('DeviceOrientationEvent' in window) {
    window.addEventListener('deviceorientation', handleOrientation);
    tiltEnabled = true;
  }
}
window.addEventListener('pointerdown', enableTilt, { once: true });

// ===== Service Worker =====
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/kaimono-app/sw.js');

resizeStage();
