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
  anytime: { sizeMult: 0.8,  color: [92, 156, 200],  text: '#34383f' }, // 青
  soon:    { sizeMult: 1.0,  color: [224, 168, 64],   text: '#34383f' }, // 黄
  hurry:   { sizeMult: 1.28, color: [214, 78, 64],    text: '#34383f' }, // 赤
};
const urgencyOf = item => (URGENCY[item.urgency] ? item.urgency : 'anytime');

// ===== サイズ（数で画面を埋める × 緊急度 × 放置日数）=====
const FILL        = 0.52;  // 画面に対する泡の総面積の割合
const R_MIN       = 44;    // 基本半径の下限
const R_MAX       = 120;   // 基本半径の上限
const GROWTH_DAYS = 5;     // この日数で成長しきる
const AGE_EXTRA   = 0.6;   // 放置で最大 +60%（古いほど大きい）

// 大きさ ＝ 基本サイズ（数で決まる）× 緊急度 × 放置日数
function recomputeSizes() {
  const arr = [...bubbles.values()];
  if (!arr.length) return;
  let base = Math.sqrt((FILL * stageW * stageH / arr.length) / Math.PI);
  base = Math.max(R_MIN, Math.min(R_MAX, base));
  const now = Date.now();
  for (const b of arr) {
    const created = b.item.createdAt?.toMillis ? b.item.createdAt.toMillis() : now;
    const ageDays = Math.max(0, (now - created) / 86400000);
    const ageMult = 1 + Math.min(ageDays / GROWTH_DAYS, 1) * AGE_EXTRA;
    let r = base * URGENCY[urgencyOf(b.item)].sizeMult * ageMult;
    r = Math.max(28, Math.min(210, r));   // 最終クランプ
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

const BAR_ZONE = 115; // 入力バー領域：泡が物理的に入り込まない高さ

let walls = [];
function buildWalls() {
  if (walls.length) World.remove(engine.world, walls);
  const t = 120, opt = { isStatic: true };
  walls = [
    Bodies.rectangle(stageW / 2, -t / 2, stageW + t * 2, t, opt),
    Bodies.rectangle(stageW / 2, stageH - BAR_ZONE + t / 2, stageW + t * 2, t, opt),
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
  uRes:     { value: new THREE.Vector2(1, 1) },
  uTextTex: { value: null },
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
  uniform vec2  uRes;
  uniform sampler2D uTextTex;
  uniform int   uCount;
  uniform vec4  uBubbles[MAX_B];   // x,y,r,colorIdx（device px・y上向き）
  uniform vec3  uColors[3];

  vec3 irid(float t){ return 0.5 + 0.5*cos(6.28318*(t + vec3(0.0,0.33,0.67))); }

  // 屈折で覗く背景（手続き的・ソフトな光点入り）
  vec3 environment(vec2 uv){
    vec3 c = mix(vec3(0.88,0.91,0.96), vec3(0.72,0.78,0.90), clamp(uv.y, 0.0, 1.0));
    c += vec3(0.45) * smoothstep(0.30, 0.0, distance(uv, vec2(0.26, 0.78)));
    c += vec3(0.28) * smoothstep(0.34, 0.0, distance(uv, vec2(0.80, 0.40)));
    return c;
  }

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

    // ★凸レンズ：中心も含め全体を少し拡大＋縁ほど強い屈折
    float rho = clamp(len / bestR, 0.0, 1.0);
    vec2 dir = (len > 0.001) ? (o / len) : vec2(0.0);
    vec2 lensP = bestC + o * (0.72 - 0.26 * rho * rho) + n.xy * (bestR * 0.15 * f);
    vec2 luv = lensP / uRes;
    float ca = 0.008 + 0.02 * f;
    vec3 refr;
    refr.r = environment(luv + dir * ca).r;
    refr.g = environment(luv).g;
    refr.b = environment(luv - dir * ca).b;

    vec3 iri = irid(n.x*0.30 + n.y*0.22 + uTime*0.04);
    vec3 L = normalize(vec3(-0.45, 0.55, 0.8));
    float spec  = pow(max(reflect(-L, n).z, 0.0), 80.0);  // 鋭い光沢
    float sheen = pow(1.0 - ndv, 1.5) * 0.22;             // 濡れた広いつや

    vec3 col = mix(refr, base, 0.42);   // 屈折した背景＋緊急色
    col += iri * f * 0.5;               // 縁の虹色
    col += vec3(1.0) * spec;            // 鋭いハイライト
    col += vec3(1.0) * sheen;           // ぬめっとしたつや

    // ★文字も同じ凸レンズ位置でサンプル＝中央もふくらむ＋色収差
    float caT = bestR * 0.016 * (f + 0.1);
    vec2 tuvG = vec2(lensP.x / uRes.x, 1.0 - lensP.y / uRes.y);
    vec2 tuvR = vec2((lensP.x + dir.x*caT) / uRes.x, 1.0 - (lensP.y + dir.y*caT) / uRes.y);
    vec2 tuvB = vec2((lensP.x - dir.x*caT) / uRes.x, 1.0 - (lensP.y - dir.y*caT) / uRes.y);
    float tr = texture2D(uTextTex, tuvR).r;
    vec4  tg = texture2D(uTextTex, tuvG);
    float tb = texture2D(uTextTex, tuvB).b;
    float ta = max(tg.a, max(texture2D(uTextTex, tuvR).a, texture2D(uTextTex, tuvB).a));
    vec3 txc = vec3(tr, tg.g, tb);
    col = mix(col, txc, ta * 0.92);

    // プラトー境界（膜の線）：暗いふち＋内側に明るい張り
    float border = 1.0 - smoothstep(0.0, bestR*bestR*0.16, edge);
    col = mix(col, col*0.6, border*0.5);
    float rib = smoothstep(0.0, bestR*bestR*0.05, edge) - smoothstep(bestR*bestR*0.05, bestR*bestR*0.18, edge);
    col += vec3(0.25) * rib;

    float alpha = (0.62 + f*0.4 + spec) * cover;
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

// ===== 粒子の2Dオーバーレイ（最前面）=====
const overlay = document.createElement('canvas');
overlay.id = 'overlay';
stage.appendChild(overlay);
const octx = overlay.getContext('2d');

// ===== 文字テクスチャ（WebGLで屈折させるためのオフスクリーン）=====
const textCanvas = document.createElement('canvas');
const tctx = textCanvas.getContext('2d');
const textTexture = new THREE.CanvasTexture(textCanvas);
textTexture.flipY = false;
textTexture.minFilter = THREE.LinearFilter;
textTexture.magFilter = THREE.LinearFilter;
foamUniforms.uTextTex.value = textTexture;

function resizeStage() {
  stageW = stage.clientWidth;
  stageH = stage.clientHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);

  renderer.setPixelRatio(dpr);
  renderer.setSize(stageW, stageH);
  foamUniforms.uRes.value.set(glCanvas.width, glCanvas.height);

  overlay.width = stageW * dpr;
  overlay.height = stageH * dpr;
  overlay.style.width = stageW + 'px';
  overlay.style.height = stageH + 'px';
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);

  textCanvas.width  = stageW * dpr;
  textCanvas.height = stageH * dpr;
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);

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
    restitution: 0.18, friction: 0, frictionAir: 0.06, density: 0.0011, slop: 0.8,
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
      x: (wanderX + cx + tiltX * 0.0024) * m,
      y: (wanderY + cy + tiltY * 0.0024) * m,
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
    const sp = Math.hypot(body.velocity.x, body.velocity.y), cap = 1.5;
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

// ===== 装飾バブル（下部フォグゾーンに湧く小さな泡）=====
const decoBubbles = [];
let lastDecoSpawn = 0;

function drawDecoBubble(cx, cy, r, alpha) {
  const g = octx.createRadialGradient(cx - r*0.3, cy - r*0.35, r*0.05, cx, cy, r);
  g.addColorStop(0,    `rgba(255,255,255,${alpha * 0.60})`);
  g.addColorStop(0.45, `rgba(210,225,245,${alpha * 0.22})`);
  g.addColorStop(1,    `rgba(180,200,230,${alpha * 0.06})`);
  octx.beginPath();
  octx.arc(cx, cy, r, 0, Math.PI * 2);
  octx.fillStyle = g;
  octx.fill();
  octx.strokeStyle = `rgba(255,255,255,${alpha * 0.50})`;
  octx.lineWidth = Math.max(0.5, r * 0.08);
  octx.stroke();
  const sr = r * 0.22;
  const sh = octx.createRadialGradient(cx - r*0.28, cy - r*0.30, 0, cx - r*0.28, cy - r*0.30, sr);
  sh.addColorStop(0, `rgba(255,255,255,${alpha * 0.80})`);
  sh.addColorStop(1, 'rgba(255,255,255,0)');
  octx.beginPath();
  octx.arc(cx - r*0.28, cy - r*0.30, sr, 0, Math.PI * 2);
  octx.fillStyle = sh;
  octx.fill();
}

function updateDecoBubbles(now) {
  if (now - lastDecoSpawn > 380 && decoBubbles.length < 20) {
    const r = 3 + Math.random() * 9;
    decoBubbles.push({
      x: r + Math.random() * (stageW - r * 2),
      y: stageH - r * 0.5,
      r,
      vx: (Math.random() - 0.5) * 0.22,
      vy: -(0.28 + Math.random() * 0.42),
      phase: Math.random() * Math.PI * 2,
      alpha: 0,
      maxAlpha: 0.50 + Math.random() * 0.30,
    });
    lastDecoSpawn = now;
  }
  const ceiling = stageH - BAR_ZONE;
  for (let i = decoBubbles.length - 1; i >= 0; i--) {
    const db = decoBubbles[i];
    db.y += db.vy;
    db.x += db.vx + Math.sin(now / 1400 + db.phase) * 0.16;
    const distToCeil = db.y - ceiling;
    if (distToCeil > db.r * 4) {
      db.alpha = Math.min(db.alpha + 0.018, db.maxAlpha);
    } else {
      db.alpha = Math.max(0, db.alpha - 0.025);
    }
    if ((db.alpha <= 0 && distToCeil < db.r) || db.x < -db.r*2 || db.x > stageW + db.r*2) {
      decoBubbles.splice(i, 1); continue;
    }
    drawDecoBubble(db.x, db.y, db.r, db.alpha);
  }
}

// ===== 描画ループ =====
function frame() {
  const now = performance.now();

  // フォーム：物理 → シェーダーuniforms（device px・y上向き）
  let bi = 0;
  for (const { body, item } of bubbles.values()) {
    if (bi >= MAX_B) break;
    const wf = 1 + body.plugin.wobble * 0.15 * Math.sin(now / 1000 * 15 + body.plugin.phase);
    foamUniforms.uBubbles.value[bi].set(
      body.position.x * dpr,
      (stageH - body.position.y) * dpr,
      body.plugin.r * 1.2 * dpr * wf, // wobble で微振動
      urgencyIndex(item)
    );
    bi++;
  }
  foamUniforms.uCount.value = bi;
  foamUniforms.uTime.value = now / 1000;

  // 文字を屈折用テクスチャへ描く（renderの前）
  tctx.clearRect(0, 0, stageW, stageH);
  for (const { body, item } of bubbles.values()) {
    const r = body.plugin.r;
    const u = URGENCY[urgencyOf(item)];
    const { x, y } = body.position;
    const text = item.name;
    const FONT = px => `600 ${px}px -apple-system, "Hiragino Sans", sans-serif`;
    const fitW    = r * 1.25;  // 収まるとき：縁から余白をとる
    const scrollW = r * 1.70;  // スクロール時：余白なしで流す

    // フォント：5文字が「余白付きの幅」に収まるサイズに（超えたらスクロール）
    let fontSize = Math.min(r * 0.42, 26);
    tctx.font = FONT(fontSize);
    const probe  = text.slice(0, 5) || text;
    const probeW = tctx.measureText(probe).width;
    if (probeW > fitW) fontSize *= fitW / probeW;
    fontSize = Math.max(fontSize, 11);
    tctx.font = FONT(fontSize);

    const fullW = tctx.measureText(text).width;
    const curv  = 0.32 / r; // 少しだけ湾曲

    tctx.save();
    tctx.beginPath();
    tctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
    tctx.clip();
    // チャコールグレー＋揺らぐ色（振幅・速度強化）
    const ph  = body.plugin.phase;
    const nt  = now / 1000;
    const flk = 30;
    const rch = Math.max(30, Math.min(120, Math.round(56 + Math.sin(nt * 3.1 + ph) * flk)));
    const gch = Math.max(30, Math.min(120, Math.round(61 + Math.sin(nt * 2.3 + ph + 1.0) * flk)));
    const bch = Math.max(30, Math.min(120, Math.round(72 + Math.sin(nt * 2.7 + ph + 2.0) * flk)));
    tctx.fillStyle = `rgb(${rch},${gch},${bch})`;
    // 泡の中で漂うドリフト（屈折レンズを通して揺れて見える）
    const textCx = x + Math.sin(nt * 1.1 + ph) * 2.5;
    const textCy = y + Math.cos(nt * 0.7 + ph * 1.3) * 1.8;
    tctx.textBaseline = 'middle';
    tctx.textAlign = 'center';

    const drawCurved = startX => {
      let gx = startX;
      for (const ch of text) {
        const cw = tctx.measureText(ch).width;
        const cxp = gx + cw / 2;
        const dx = cxp - textCx;
        const yy = textCy + curv * dx * dx;            // 湾曲（下に弧）
        const rot = Math.atan(2 * curv * dx);     // 接線方向に回転
        tctx.save();
        tctx.translate(cxp, yy);
        tctx.rotate(rot);
        tctx.fillText(ch, 0, 0);
        tctx.restore();
        gx += cw;
      }
    };

    if (fullW <= fitW) {
      drawCurved(textCx - fullW / 2);                 // 余白付きで中央に
    } else {
      const span = fullW + 40;
      const offset = (now / 22) % span;
      drawCurved(textCx - scrollW / 2 - offset);      // 余白なしで流す
      drawCurved(textCx - scrollW / 2 - offset + span);
    }
    tctx.restore();
  }
  textTexture.needsUpdate = true;

  renderer.render(scene, camera);

  // 粒子＋装飾バブル（最前面）
  octx.clearRect(0, 0, stageW, stageH);
  updateDecoBubbles(now);
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

// ===== アンドゥトースト =====
const undoToastEl    = document.getElementById('undo-toast');
const undoLabelEl    = document.getElementById('undo-label');
const undoBtnEl      = document.getElementById('undo-btn');
let undoTargetItem   = null;
let undoHideTimer    = null;
let undoDismissTimer = null;

function showUndoToast(item) {
  undoTargetItem = item;
  undoLabelEl.textContent = `「${item.name}」を消した`;
  clearTimeout(undoHideTimer);
  clearTimeout(undoDismissTimer);
  undoToastEl.classList.remove('hidden', 'fading');
  undoHideTimer = setTimeout(hideUndoToast, 5000);
}
function hideUndoToast() {
  undoToastEl.classList.add('fading');
  undoDismissTimer = setTimeout(() => {
    undoToastEl.classList.add('hidden');
    undoTargetItem = null;
  }, 300);
}
undoBtnEl.addEventListener('click', () => {
  if (!undoTargetItem) return;
  undoBought(undoTargetItem.id);
  clearTimeout(undoHideTimer);
  clearTimeout(undoDismissTimer);
  undoToastEl.classList.add('hidden');
  undoTargetItem = null;
});

// ===== 短押し → プルプル ／ 長押し（700ms）→ 弾ける =====
const LONG_PRESS_MS = 700;
let lpBody = null, lpStart = 0, lpAutoTimer = null, lpPoint = null;

overlay.addEventListener('pointerdown', e => {
  if (!urgencyPop.classList.contains('hidden')) { closeUrgencyPop(); return; }
  const rect = overlay.getBoundingClientRect();
  const pt   = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const hit  = Query.point([...bubbles.values()].map(b => b.body), pt)[0];
  if (!hit) return;
  lpBody = hit; lpStart = performance.now(); lpPoint = pt;
  lpAutoTimer = setTimeout(() => {
    if (lpBody === hit) {
      const item = hit.plugin.item;
      removeBubble(hit.plugin.id, true);
      markBought(hit.plugin.id);
      showUndoToast(item);
      lpBody = null;
    }
  }, LONG_PRESS_MS);
});

overlay.addEventListener('pointerup', () => {
  clearTimeout(lpAutoTimer);
  if (lpBody && performance.now() - lpStart < LONG_PRESS_MS) {
    // タッチ位置→バブル中心の方向に突き飛ばす（物理的な突き）
    const dx = lpBody.position.x - (lpPoint ? lpPoint.x : lpBody.position.x);
    const dy = lpBody.position.y - (lpPoint ? lpPoint.y : lpBody.position.y);
    const d  = Math.hypot(dx, dy) || 1;
    Body.setVelocity(lpBody, {
      x: lpBody.velocity.x + (dx / d) * 2.2,
      y: lpBody.velocity.y + (dy / d) * 2.2,
    });
    lpBody.plugin.wobble = Math.max(lpBody.plugin.wobble, 0.5);
    // 近くのバブルへ距離の2乗で減衰して伝播
    const { x: tx, y: ty } = lpBody.position;
    for (const { body } of bubbles.values()) {
      if (body === lpBody) continue;
      const nx = body.position.x - tx, ny = body.position.y - ty;
      const dist = Math.hypot(nx, ny);
      if (dist < 300) {
        const str = Math.pow(1 - dist / 300, 2);
        body.plugin.wobble = Math.max(body.plugin.wobble, 0.5 * str);
        const nd = dist || 1;
        Body.setVelocity(body, {
          x: body.velocity.x + (nx / nd) * str * 0.7,
          y: body.velocity.y + (ny / nd) * str * 0.7,
        });
      }
    }
  }
  lpBody = null;
});

overlay.addEventListener('pointercancel', () => {
  clearTimeout(lpAutoTimer);
  lpBody = null;
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
