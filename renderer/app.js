// Luxora istemci — kabuk.
//
// Akış: açılış videosu → doğrudan Haxball'un kendi oda listesi. Ayrı bir
// kategori ya da oda listesi yok; Luxora odaları zaten Haxball'un listesinde
// (odalar public). Oyuncu hangi odaya girerse girsin oyun katmanı
// (game-preload.js) bunu anlıyor: Luxora odasıysa ses kendiliğinden açılıyor,
// değilse "burada sesli sohbet çalışmaz" uyarısı çıkıyor.
//
// Kabuğun buradaki işi: üst çubuk, canlı oda verisini oyun katmanına iletmek,
// oyun görünümünün yerini ölçmek.

const SITE = 'https://luxorafutsal.com';
const LIVE = 'wss://luxorafutsal.com/live';
const HAXBALL = 'https://www.haxball.com/play';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  rooms: [],
  bridge: false,
  me: null,
  authKnown: false,   // oturum sorgusu döndü mü
  full: false,
};

// ── Canlı veri ───────────────────────────────────────────────────────────────
// Sitenin kullandığı yerden okunuyor: soket açıkken veri kendiliğinden geliyor,
// kopunca /api/state yoklamasına iniliyor. Yalnızca okuma.

let ws = null;
let pollTimer = null;
let retry = 0;

function connect() {
  let sock;
  try { sock = new WebSocket(LIVE); } catch { return schedulePoll(); }
  ws = sock;
  sock.onopen = () => { retry = 0; stopPoll(); };
  sock.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'hello' || m.type === 'rooms') applySnapshot(m.snapshot, m.bridge);
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    schedulePoll();
    retry += 1;
    setTimeout(connect, Math.min(1000 * retry, 15000));
  };
  sock.onerror = () => { try { sock.close(); } catch {} };
}

function schedulePoll() {
  if (pollTimer) return;
  poll();
  pollTimer = setInterval(poll, 5000);
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function poll() {
  try {
    const r = await fetch(`${SITE}/api/state`, { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    applySnapshot(d.snapshot, d.bridge);
  } catch {
    state.bridge = false;
    renderLive();
  }
}

function applySnapshot(snap, bridge) {
  state.bridge = !!snap && bridge !== false;
  state.rooms = (snap && Array.isArray(snap.rooms)) ? snap.rooms : [];
  renderLive();
  pushToGame();
}

// Oda listesi ve kimlik oyun katmanına gidiyor; katman hangi odada olunduğunu
// bununla eşleştiriyor, takım bilgisini de buradan alıyor.
// Oturum henüz sorulmadıysa 'me' hiç gönderilmiyor: "bilinmiyor" ile
// "çıkış yapılmış" ayrı şeyler. Eskiden açılıştaki ilk gönderim "çıkış
// yapılmış" sayılıp mikrofon kapatılabiliyordu.
function pushToGame() {
  const d = { rooms: state.rooms.map((r) => ({ id: r.id, name: r.name, players: r.players || [] })) };
  if (state.authKnown) d.me = state.me ? state.me.nick : null;
  window.lux.voice.room(d);
}

// ── Üst çubuk ────────────────────────────────────────────────────────────────

function renderLive() {
  const el = $('#live');
  if (!state.bridge) {
    el.hidden = false;
    $('#live-dot').className = 'dot off';
    $('#live-txt').textContent = 'Luxora sunucusuna ulaşılamıyor';
    return;
  }
  const open = state.rooms.filter((r) => r.online);
  const online = open.reduce((s, r) => s + (r.count || 0), 0);
  el.hidden = false;
  $('#live-dot').className = 'dot ok';
  $('#live-txt').innerHTML = `Luxora'da <b>${online}</b> oyuncu · <b>${open.length}</b> oda açık`;
}

function renderAccount() {
  $('#login').hidden = !!state.me;
  $('#who').hidden = !state.me;
  if (state.me) {
    $('#who-nick').textContent = state.me.nick;
    $('#who-av').textContent = (state.me.nick || '?').trim().charAt(0).toLocaleUpperCase('tr');
  }
}

const VSTATE = {
  off: ['Ses kapalı', ''],
  'no-name': ['Ad eşleşmiyor', 'warn'],
  waiting: ['Sahada değilsin', 'warn'],
  'no-server': ['Ses sunucusu yok', 'off'],
  connecting: ['Ses bağlanıyor', 'warn'],
  live: ['Ses canlı', 'ok'],
};

// Ses durumu yalnızca bir Luxora odasındayken görünür.
function onVoiceStatus(s) {
  const pill = $('#vpill');
  if (!s || !s.lux) { pill.hidden = true; return; }
  const [txt, cls] = VSTATE[s.mic ? s.state : 'off'] || VSTATE.off;
  pill.hidden = false;
  $('#vdot').className = `dot ${cls} ${s.tx ? 'tx' : ''}`;
  $('#vtxt').innerHTML = `${txt} · <b>${s.room || ''}</b>`;
}

// ── Oyun alanı ───────────────────────────────────────────────────────────────

function setStage(kind, text) {
  const msg = $('#stage-msg');
  if (kind === 'ready') { msg.hidden = true; return; }
  msg.hidden = false;
  $('#spin').hidden = kind !== 'loading';
  $('#retry').hidden = kind !== 'error';
  $('#stage-txt').textContent = text;
}

async function openGame() {
  setStage('loading', 'Haxball yükleniyor');
  startStageTracking();
  const r = await window.lux.game.open(HAXBALL);
  if (!r || !r.ok) setStage('error', 'Haxball açılamadı.');
}

// WebContentsView HTML'in üstünde çizildiği için yerini ölçüp ana sürece
// bildiriyoruz. İki saniyede bir de tazeleniyor: ölçü bir şekilde kayarsa
// oyun ekranı "kaybolmuş" gibi görünmesin.
let ro = null;
let heal = 0;
let lastRect = '';

function sendBounds(force) {
  const r = $('#stage').getBoundingClientRect();
  const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
  if (!force && key === lastRect) return;
  lastRect = key;
  window.lux.game.bounds({ x: r.x, y: r.y, width: r.width, height: r.height });
}

function startStageTracking() {
  lastRect = '';
  sendBounds(true);
  if (!ro) { ro = new ResizeObserver(() => sendBounds()); ro.observe($('#stage')); }
  window.addEventListener('resize', () => sendBounds());
  if (!heal) heal = setInterval(() => sendBounds(true), 2000);
}

// ── Açılış ───────────────────────────────────────────────────────────────────

function initIntro() {
  const intro = $('#intro');
  const v = $('#intro-video');
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    intro.classList.add('out');
    setTimeout(() => { try { v.pause(); } catch {} intro.hidden = true; }, 480);
    openGame();
  };

  v.addEventListener('ended', finish);
  v.addEventListener('error', finish);
  $('#skip').addEventListener('click', finish);
  setTimeout(() => { if (v.readyState === 0) finish(); }, 6000);
}

// ── Bağlama ──────────────────────────────────────────────────────────────────

function init() {
  initIntro();

  // Platforma göre küçük farklar (Mac'te pencere düğmeleri gibi) CSS'te.
  window.lux.info().then((i) => document.body.classList.add(`os-${i.platform}`)).catch(() => {});

  $$('[data-win]').forEach((b) => b.addEventListener('click', () => window.lux.win(b.dataset.win)));
  $('#fs').addEventListener('click', () => window.lux.win('full'));
  $('#retry').addEventListener('click', openGame);

  // Giriş formu oyunun üstündeki katmanda açılıyor (kabuk oraya çizemez).
  $('#login').addEventListener('click', () => window.lux.voice.showLogin());
  $('#logout').addEventListener('click', async () => {
    await window.lux.auth.logout();
  });

  window.lux.auth.onChanged((m) => {
    state.me = m || null;
    state.authKnown = true;
    renderAccount();
    pushToGame();
  });

  window.lux.onWinState((s) => {
    state.full = !!s.full;
    document.body.classList.toggle('full', state.full);
    setTimeout(() => sendBounds(true), 60);
  });

  window.lux.voice.onStatus(onVoiceStatus);
  window.lux.game.onLoaded(() => { setStage('ready'); sendBounds(true); });
  window.lux.game.onFailed(({ desc }) => setStage('error', `Haxball açılamadı${desc ? ` (${desc})` : ''}.`));

  // Kabuktaki bir düğmeye basılınca klavye odağı oyuna geri verilsin;
  // yoksa tuşlar oyuna değil kabuğa gidiyor.
  document.addEventListener('click', (e) => {
    if (e.target.closest('#intro')) return;
    setTimeout(() => window.lux.game.focus(), 0);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') { e.preventDefault(); window.lux.win('full'); return; }
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'))) { e.preventDefault(); return; }
    if (e.key === 'Tab') e.preventDefault();
  });

  renderAccount();
  connect();
  schedulePoll();

  // Oturum kalıcı: daha önce girdiyse sormadan devam.
  window.lux.auth.me().then((m) => {
    state.me = m || null;
    state.authKnown = true;
    renderAccount();
    pushToGame();
  }).catch(() => { state.authKnown = true; pushToGame(); });
}

init();
