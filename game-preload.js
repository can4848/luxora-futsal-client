// Oyun sayfasına enjekte edilen katman: ses paneli, giriş kartı, oda uyarısı.
//
// NEDEN BURADA — Oyun görünümü (WebContentsView) kabuğun HTML'inin ÜSTÜNDE
// çizilir; kabuk oyunun üzerine hiçbir şey bindiremez. Yandan sütun açmak da
// oyuncunun alanını yerdi. Katman bu yüzden oyunun kendi sayfasına, kendi
// shadow DOM'u içinde ekleniyor; oyunun CSS'i ile karışmıyor.
//
// HANGİ ODADAYIZ — Haxball listeden odaya girince adres çubuğunu değiştirmiyor
// (oyun kodunda replaceState/pushState yok). Ama oyun çerçevesi aynı kaynakta
// (www.haxball.com) ve odaya girince adını `h1[data-hook="room-name"]`
// öğesine yazıyor. Onu okuyup canlı Luxora oda listesiyle eşleştiriyoruz.
//
// KLAVYE — Oyun tuşları çerçevenin (iframe) belgesinde dinleniyor. Üst sayfaya
// takılan dinleyici oynarken hiçbir tuşu görmüyordu; bas-konuş bu yüzden
// çerçeveye de takılıyor. Tab ve Enter oyunun SOHBET tuşları: dokunulmuyor.

const { ipcRenderer } = require('electron');
const { VoiceEngine } = require('./voice');

const voice = new VoiceEngine();
voice.getToken = (room) => ipcRenderer.invoke('voice:token', room);
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

const POS_KEY = 'lux.voice.pos';
const OFF_KEY = 'lux.voice.userOff';   // oyuncu sesi kendisi kapattıysa: otomatik açma
const SCOPE_KEY = 'lux.voice.scope';   // özel / genel tercihi
const CONSENT_KEY = 'lux.voice.consent'; // oyuncu mikrofona bir kez izin verdi mi
const NICK_KEY = 'lux.lastNick';         // son giriş yapılan kullanıcı adı

const CHANNEL_NAME = { red: 'Kırmızı takım', blue: 'Mavi takım', spec: 'İzleyiciler', general: 'Genel sohbet' };

const data = { rooms: [], me: null };
const where = { inRoom: false, name: null, room: null };
let ui = null;

// ── Görünüm ──────────────────────────────────────────────────────────────────
// Sade tutuldu: tek vurgu rengi, düz yüzeyler, sistem yazı tipi. Oyunun
// üstünde duran bir şey göz yormamalı; dikkat çekmesi gereken tek an birinin
// konuştuğu an.

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; }
/* ŞART: .veil (grid) ve .toast (flex) kendi display değerlerini veriyor ve bu
   hidden niteliğini eziyordu. Giriş perdesi gizliyken bile ekranı karartıp
   bütün tıklamaları yutuyordu — oyuncu hiçbir şeye basamıyordu. */
[hidden] { display: none !important; }
.root {
  --bg: rgba(20, 19, 27, .96);
  --bg-2: rgba(255, 255, 255, .04);
  --line: rgba(255, 255, 255, .08);
  --text: #f2f1f5;
  --muted: #a19eae;
  --dim: #6e6b7b;
  --accent: #8b6cff;
  --ok: #3ecf8e;
  --red: #ff6b5a;
  --blue: #4c8dff;
  --warn: #f5b84b;
  font-family: "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, "Ubuntu", "Cantarell", sans-serif;
  font-size: 13px; line-height: 1.4; color: var(--text);
  -webkit-font-smoothing: antialiased;
  /* Açılır listeler gibi yerel denetimler koyu çizilsin. Yoksa Windows
     seçenek listesini beyaz zeminde açıyor, yazı da beyaz: okunmuyordu. */
  color-scheme: dark;
}
select option { background: #1d1c26; color: #f2f1f5; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
input, select { font: inherit; color: inherit; }
svg { display: block; }

/* ── Sağ üstte duran katman ─────────────────────────────────────────────── */
.dock {
  position: fixed; z-index: 2147483000; top: 12px; right: 12px;
  width: max-content; transition: opacity .3s;
}
.dock.idle { opacity: .5; }
.dock:hover { opacity: 1; }

.pane {
  background: var(--bg); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .45);
  backdrop-filter: blur(12px); overflow: hidden;
}

/* Kapsül */
.cap { display: flex; align-items: center; gap: 10px; padding: 6px 10px 6px 6px; cursor: grab; user-select: none; }
.cap:active { cursor: grabbing; }
.mic {
  position: relative; width: 28px; height: 28px; flex: none; display: grid; place-items: center;
  border-radius: 50%; background: var(--bg-2); color: var(--muted);
  transition: background .15s, color .15s;
}
.mic svg { width: 14px; height: 14px; }
.mic:hover { background: rgba(255,255,255,.09); color: var(--text); }
.mic.on { color: var(--ok); background: rgba(62, 207, 142, .12); }
.mic.tx { color: #0b1a12; background: var(--ok); }
.mic .ring {
  position: absolute; inset: -3px; border-radius: 50%; border: 2px solid var(--ok);
  opacity: 0; pointer-events: none;
}
.mic.tx .ring { opacity: calc(.25 + var(--l, 0) * .75); }

.cap-txt { font-size: 12px; color: var(--muted); white-space: nowrap; }
.cap-txt b { color: var(--text); font-weight: 600; }
.faces { display: flex; }
.chev { color: var(--dim); padding: 4px; border-radius: 6px; }
.chev:hover { color: var(--text); background: var(--bg-2); }
.chev svg { width: 12px; height: 12px; transition: transform .2s; }
.chev.up svg { transform: rotate(180deg); }

.av {
  width: 22px; height: 22px; border-radius: 50%; flex: none;
  display: grid; place-items: center; font-size: 10px; font-weight: 700;
  background: #2a2836; color: var(--muted); box-shadow: 0 0 0 2px var(--bg);
  transition: box-shadow .15s;
}
.faces .av + .av { margin-left: -6px; }
.av.t1 { background: #3a2023; color: #ffb0a6; }
.av.t2 { background: #1d2740; color: #a9c6ff; }
.av.sp { box-shadow: 0 0 0 2px var(--ok); }

/* Açık panel */
/* Küçük pencerede panel ekrandan taşıp alttaki düğmelere ulaşılamıyordu;
   ekrana sığmadığında kendi içinde kayar. */
.body {
  width: 288px; border-top: 1px solid var(--line);
  max-height: calc(100vh - 90px); overflow-y: auto; overscroll-behavior: contain;
}
.body::-webkit-scrollbar { width: 8px; }
.body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
.sec { padding: 12px 14px; }
.sec + .sec { border-top: 1px solid var(--line); }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.title { font-weight: 600; font-size: 13px; }
.room { font-size: 12px; color: var(--muted); margin-top: 1px; }
.badge {
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 99px;
  background: var(--bg-2); color: var(--muted); white-space: nowrap;
}
.badge.live { background: rgba(62,207,142,.14); color: var(--ok); }
.badge.warn { background: rgba(245,184,75,.14); color: var(--warn); }
.badge.bad { background: rgba(255,107,90,.14); color: var(--red); }

.lbl { font-size: 11px; color: var(--dim); margin-bottom: 8px; }
.mates { display: flex; flex-direction: column; gap: 2px; }
.mate { display: grid; grid-template-columns: 22px 1fr auto; align-items: center; gap: 4px 10px; padding: 6px; border-radius: 8px; }
.mate:hover { background: var(--bg-2); }
.mate .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mate .st { font-size: 11px; color: var(--dim); }
.mate.sp .st { color: var(--ok); }
.mate .vol { grid-column: 2 / -1; display: flex; align-items: center; gap: 8px; }
.mate .vol span { font-size: 11px; color: var(--dim); width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
.ic { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 6px; color: var(--dim); }
.ic:hover { color: var(--text); background: var(--bg-2); }
.ic.muted { color: var(--red); }
.ic svg { width: 14px; height: 14px; }
.empty { color: var(--dim); font-size: 12px; padding: 4px 6px; }

.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 30px; }
.row + .row { margin-top: 4px; }
.row > span { font-size: 12px; color: var(--muted); }
.seg { display: flex; background: var(--bg-2); border-radius: 8px; padding: 2px; }
.seg button { font-size: 12px; padding: 4px 10px; border-radius: 6px; color: var(--muted); }
.seg button.on { background: rgba(255,255,255,.1); color: var(--text); }
select {
  width: 156px; height: 28px; padding: 0 8px; font-size: 12px; color: var(--text);
  background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px; outline: none;
}
input[type=range] { -webkit-appearance: none; width: 156px; height: 4px; border-radius: 99px; background: rgba(255,255,255,.12); outline: none; }
.mate input[type=range] { width: 100%; }
input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: var(--text);
}
kbd {
  font-family: inherit; font-size: 12px; font-weight: 600; min-width: 32px; text-align: center;
  padding: 3px 10px; border-radius: 6px; background: var(--bg-2); border: 1px solid var(--line);
  border-bottom-width: 2px; cursor: pointer;
}
kbd.wait { color: var(--warn); border-color: rgba(245,184,75,.4); }

.meter { position: relative; height: 6px; border-radius: 99px; background: rgba(255,255,255,.07); margin: 8px 0; overflow: hidden; }
.meter i { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--ok); border-radius: 99px; transition: width .06s linear; }
.meter b { position: absolute; left: 12%; top: 0; bottom: 0; width: 2px; background: rgba(255,255,255,.35); }
.note { font-size: 12px; color: var(--muted); line-height: 1.45; }
.note + .note, .meter + .note { margin-top: 6px; }
.note.err { color: var(--red); }
.note b { color: var(--text); font-weight: 600; }

.btn {
  height: 32px; padding: 0 14px; border-radius: 8px; font-size: 12px; font-weight: 600;
  background: var(--bg-2); border: 1px solid var(--line);
}
.btn:hover { background: rgba(255,255,255,.09); }
.btn:disabled { opacity: .4; cursor: default; }
.btn.primary { background: var(--accent); border-color: transparent; color: #fff; }
.btn.primary:hover { background: #9a7fff; }
.btn.danger { color: var(--red); }
.btn.wide { width: 100%; }

/* Özel / Genel */
.scope { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; background: var(--bg-2); border-radius: 10px; padding: 3px; margin-bottom: 10px; }
.scope button { padding: 7px 9px; border-radius: 8px; text-align: left; }
.scope button b { display: block; font-size: 12.5px; font-weight: 600; }
.scope button span { display: block; font-size: 11px; color: var(--dim); }
.scope button.on { background: rgba(255,255,255,.1); }
.scope button.on span { color: var(--muted); }
.chan { display: inline-flex; align-items: center; gap: 6px; }
.chan i { width: 8px; height: 8px; border-radius: 2px; background: var(--dim); }
.chan.red i { background: var(--red); }
.chan.blue i { background: var(--blue); }
.chan.general i { background: var(--accent); }

/* ── Sol üstte konuşanlar ───────────────────────────────────────────────── */
/* Kim konuşuyorsa adı burada görünür. Sahayı kapatmasın diye tıklamayı
   geçirir ve yalnızca biri konuşurken dolu olur. */
.talkers {
  position: fixed; z-index: 2147482999; top: 46px; left: 12px;
  display: flex; flex-direction: column; gap: 6px; pointer-events: none;
}
.talker {
  display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 12px 0 4px;
  background: rgba(20, 19, 27, .88); border: 1px solid var(--line); border-radius: 99px;
  box-shadow: 0 4px 14px rgba(0,0,0,.35); animation: tIn .22s ease-out;
  transition: opacity .3s ease, transform .3s ease;
}
/* Konuşma bitince kutu birden kaybolmasın, yavaşça sönsün. */
.talker.out { opacity: 0; transform: translateX(-8px); }
.talker .av { width: 22px; height: 22px; box-shadow: 0 0 0 2px var(--ok); }
.talker .tn { font-size: 12.5px; font-weight: 600; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.talker .eq { display: flex; align-items: flex-end; gap: 2px; height: 12px; }
.talker .eq i { width: 3px; height: 4px; background: var(--ok); border-radius: 2px; animation: eq .8s ease-in-out infinite; }
.talker .eq i:nth-child(2) { animation-delay: .15s; }
.talker .eq i:nth-child(3) { animation-delay: .3s; }
@keyframes eq { 0%, 100% { height: 3px; } 50% { height: 12px; } }
@keyframes tIn { from { opacity: 0; transform: translateX(-8px); } }

/* İlk kez: uygulama içi mikrofon izni isteği */
.ask { width: 300px; padding: 14px; }
.ask-top { display: flex; gap: 12px; margin-bottom: 12px; }
.ask-ic {
  width: 34px; height: 34px; flex: none; border-radius: 50%; display: grid; place-items: center;
  background: rgba(139,108,255,.16); color: var(--accent);
}
.ask-ic svg { width: 16px; height: 16px; }
.ask b { display: block; font-size: 13.5px; font-weight: 600; margin-bottom: 3px; }
.ask p { font-size: 12px; color: var(--muted); line-height: 1.45; }
.ask-acts { display: flex; gap: 8px; }
.ask-acts .btn { flex: 1; }

.cap-txt .err { color: var(--red); }
.errbox { padding: 10px 12px; margin-bottom: 10px; border-radius: 8px; background: rgba(255,107,90,.1); }
.errbox p { font-size: 12px; color: #ffc2b8; line-height: 1.45; }
.errbox .acts { display: flex; gap: 6px; margin-top: 8px; }

/* ── Uyarı (Luxora dışı oda) ────────────────────────────────────────────── */
.toast {
  position: fixed; z-index: 2147483001; top: 14px; left: 50%; transform: translate(-50%, -8px);
  display: flex; align-items: flex-start; gap: 10px; max-width: 460px;
  padding: 11px 12px 11px 14px; background: var(--bg); border: 1px solid var(--line);
  border-left: 3px solid var(--warn); border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.45); opacity: 0; transition: opacity .2s, transform .2s;
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast .t-ic { color: var(--warn); margin-top: 1px; }
.toast .t-ic svg { width: 16px; height: 16px; }
.toast .t-txt b { display: block; font-weight: 600; margin-bottom: 1px; }
.toast .t-txt { font-size: 12.5px; color: var(--muted); }
.toast .ic { margin: -2px -4px 0 4px; }

/* ── Giriş kartı ─────────────────────────────────────────────────────────── */
.veil {
  position: fixed; inset: 0; z-index: 2147483002; display: grid; place-items: center;
  background: rgba(8, 8, 12, .55);
}
.card {
  width: 340px; padding: 22px; background: #16151d; border: 1px solid var(--line);
  border-radius: 14px; box-shadow: 0 20px 50px rgba(0,0,0,.5);
}
.card h2 { font-size: 17px; font-weight: 600; margin-bottom: 6px; }
.card > p { font-size: 12.5px; color: var(--muted); margin-bottom: 18px; line-height: 1.5; }
.field { display: block; margin-bottom: 12px; }
.field span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.field input {
  width: 100%; height: 38px; padding: 0 12px; font-size: 14px;
  background: rgba(255,255,255,.05); border: 1px solid var(--line); border-radius: 8px; outline: none;
}
.field input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(139,108,255,.2); }
.card .err { font-size: 12.5px; color: var(--red); margin: 2px 0 12px; }
.card .acts { display: flex; gap: 8px; margin-top: 6px; }
.card .acts .btn { height: 38px; flex: 1; }
.card .foot { font-size: 12px; color: var(--dim); margin-top: 14px; line-height: 1.5; }
.card .foot code { font-family: inherit; color: var(--text); background: var(--bg-2); padding: 1px 6px; border-radius: 4px; white-space: nowrap; }
`;

const I = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5"/><path d="M19 11a7 7 0 0 1-1.2 3.9M5 11a7 7 0 0 0 10.8 5.9M12 18v3M3 3l18 18"/></svg>',
  spk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
  spkOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

const STATUS = {
  off: ['Kapalı', ''],
  'no-name': ['Adın eşleşmiyor', 'warn'],
  'no-server': ['Sunucuya ulaşılamıyor', 'bad'],
  'no-auth': ['Giriş doğrulanamadı', 'bad'],
  update: ['Güncelleme gerekli', 'bad'],
  replaced: ['Başka yerde açık', 'warn'],
  connecting: ['Bağlanıyor', 'warn'],
  live: ['Canlı', 'live'],
};

// ── Katmanın iskeleti ────────────────────────────────────────────────────────

function build() {
  if (ui || !document.body) return;

  const host = document.createElement('div');
  host.id = 'lux-layer';
  const sh = host.attachShadow({ mode: 'open' });

  // Stil <style> yerine yapılandırılmış sayfa olarak veriliyor: oyunun
  // sayfasında katı bir CSP olsaydı satır içi stil engellenebilirdi.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    sh.adoptedStyleSheets = [sheet];
  } catch {
    const st = document.createElement('style');
    st.textContent = CSS;
    sh.appendChild(st);
  }

  const root = document.createElement('div');
  root.className = 'root';
  root.innerHTML = '<div class="talkers"></div><div class="dock" hidden></div><div class="toast" hidden></div><div class="veil" hidden></div>';
  sh.appendChild(root);
  document.body.appendChild(host);

  ui = {
    host, root,
    dock: root.querySelector('.dock'),
    talkers: root.querySelector('.talkers'),
    toast: root.querySelector('.toast'),
    veil: root.querySelector('.veil'),
    open: false, pickKey: false, idle: 0, toastT: 0, devs: [],
    login: false, loginErr: '', busy: false,
  };
  restorePos();
  wireDrag();
  render();
}

// ── Hangi odadayız ───────────────────────────────────────────────────────────

const frameEl = () => document.querySelector('iframe.gameframe');
function frameDoc() {
  try { const f = frameEl(); return f && f.contentDocument; } catch { return null; }
}

// Ad karşılaştırması: emojiler, işaretler, büyük-küçük harf farkı yok sayılır.
// Haxball'daki ad "🌌✨💫 Luxora Futsal Acemi 3", canlı listedeki ad "Acemi 3".
const norm = (s) => String(s || '')
  .normalize('NFKC').toLocaleLowerCase('tr')
  .replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

const isLuxoraName = (name) => norm(name).includes('luxora futsal');

function matchRoom(name) {
  const n = norm(name);
  let best = null;
  for (const r of data.rooms) {
    const s = norm(r.name);
    // En uzun eşleşme kazanır: "bff ağır acemi 2" ile "ağır acemi 2" karışmasın.
    if (s && n.endsWith(s) && (!best || s.length > norm(best.name).length)) best = r;
  }
  return best;
}

// Giriş yapılmışsa Haxball'un "Choose nickname" ekranı hesabın adıyla
// kendiliğinden geçilir; oyuncu doğrudan oda listesine düşer. Sesli sohbet
// zaten oyundaki adın hesabın adıyla aynı olmasını istiyor. Yalnızca açılıştaki
// ekran geçilir: oda listesine bir kez varıldıktan sonra oyuncu "Change nick"
// ile adını kendisi değiştirmek isterse ekrana dokunulmaz.
let pastNickScreen = false;
function skipNickScreen(d) {
  if (pastNickScreen || !d) return;
  if (d.querySelector('.roomlist-view, .game-view')) { pastNickScreen = true; return; }
  if (!data.me) return;
  const v = d.querySelector('.choose-nickname-view');
  const input = v && v.querySelector('[data-hook="input"]');
  const ok = v && v.querySelector('[data-hook="ok"]');
  if (!input || !ok) return;
  input.value = String(data.me).slice(0, Number(input.maxLength) > 0 ? input.maxLength : 25);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  ok.click();
  pastNickScreen = true;
}

function detect() {
  hookFrame();
  const d = frameDoc();
  skipNickScreen(d);
  const inGame = !!(d && d.querySelector('.game-view'));

  if (!inGame) {
    if (where.inRoom) onLeave();
    return;
  }
  const h = d.querySelector('[data-hook="room-name"]');
  const name = (h && h.textContent.trim()) || where.name;
  // Odaya yeni girildi ama ad henüz yazılmadı: bir sonraki turu bekle.
  if (!name) return;
  if (!where.inRoom || name !== where.name) onEnter(name);
}

function onEnter(name) {
  where.inRoom = true;
  where.name = name;
  where.room = null;

  if (!isLuxoraName(name)) {
    stopVoice();
    toast('Sesli sohbet bu odada çalışmaz', 'Sesli sohbet yalnızca Luxora odalarında açılır. Bu odada oynamaya devam edebilirsin.');
    render();
    return;
  }

  where.room = matchRoom(name);
  if (!where.room) {
    stopVoice();
    toast('Bu odada sesli sohbet yok', 'Bu Luxora odası henüz sesli sohbete bağlanmadı.');
    render();
    return;
  }
  hideToast();
  activate();
}

function onLeave() {
  where.inRoom = false;
  where.name = null;
  where.room = null;
  stopVoice();
  hideToast();
  render();
}

// Luxora odasında ses kendiliğinden açılır. Bas-konuş kipinde başladığı için
// tuşa basılmadıkça hiçbir ses gönderilmez. Mikrofon ilk kez açılmadan önce
// oyuncuya uygulama içinde sorulur (Windows'ta işletim sistemi sormuyor;
// sormadan açmak doğru değil). Bir kez izin verince bir daha sorulmaz.
// Oyuncu sesi kendisi kapattıysa tercihine saygı gösterilir.
function activate() {
  const r = where.room;
  voice.scope = savedScope();
  voice.setRoom({ id: r.id, name: r.name }, r.players || []);
  if (!data.me) { render(); return; }
  voice.setIdentity(data.me);
  if (consent() !== 'yes') {
    if (!ui.declined) ui.ask = true;
  } else if (!userOff() && !voice.micOn) {
    startMic();
  }
  render();
}

// Açılamazsa panel kendiliğinden açılır: oyuncu ne olduğunu ve ne
// yapacağını görsün, "neden çalışmıyor" diye kalmasın.
async function startMic() {
  const ok = await voice.enableMic();
  if (ok) loadDevices();
  else if (ui) { ui.open = true; render(); }
  return ok;
}

const consent = () => { try { return localStorage.getItem(CONSENT_KEY); } catch { return null; } };
const setConsent = (v) => { try { localStorage.setItem(CONSENT_KEY, v); } catch {} };

function stopVoice() {
  if (voice.micOn) voice.disableMic();
  if (voice.room) voice.leaveRoom();
}

const savedScope = () => { try { return localStorage.getItem(SCOPE_KEY) === 'general' ? 'general' : 'team'; } catch { return 'team'; } };

const userOff = () => { try { return localStorage.getItem(OFF_KEY) === '1'; } catch { return false; } };
const setUserOff = (v) => { try { localStorage.setItem(OFF_KEY, v ? '1' : '0'); } catch {} };

// Haxball'da seçilen ad aynı kaynağın deposunda duruyor; hesapla eşleşmezse
// panel iki adı yan yana gösterip neyin düzeltileceğini söylüyor.
function haxNick() {
  try {
    const v = localStorage.getItem('player_name') || '';
    return v.replace(/^"|"$/g, '');
  } catch { return ''; }
}

// ── Çizim ────────────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = (n) => esc((String(n || '?').trim().charAt(0) || '?').toLocaleUpperCase('tr'));

function render() {
  if (!ui) return;
  renderDock();
  renderTalkers();
  renderLogin();
}

// Sol üst: şu an konuşan takım/kanal arkadaşları. Kendi adın burada yok —
// kendi konuştuğunu mikrofon düğmesinin yeşil yanmasından görüyorsun.
// Kutular tek tek eklenip çıkarılıyor: biri susunca yalnız onunki yavaşça
// söner, diğerleri yerinden oynamaz.
function renderTalkers() {
  const want = new Map();
  if (where.room) {
    for (const m of voice.teammates()) {
      const p = voice.peers.get(m.name);
      if (p && p.speaking && !p.muted) want.set(m.name, m);
    }
  }
  for (const el of Array.from(ui.talkers.children)) {
    if (want.has(el._name)) {
      el.classList.remove('out');
      want.delete(el._name);
    } else if (!el.classList.contains('out')) {
      el.classList.add('out');
      setTimeout(() => { if (el.classList.contains('out')) el.remove(); }, 320);
    }
  }
  for (const m of want.values()) {
    const el = document.createElement('div');
    el.className = 'talker';
    el._name = m.name;
    el.innerHTML = `
      <span class="av t${m.team || 0}">${initial(m.name)}</span>
      <span class="tn">${esc(m.name)}</span>
      <span class="eq"><i></i><i></i><i></i></span>`;
    ui.talkers.appendChild(el);
  }
}

function renderDock() {
  const show = where.inRoom && !!where.room;
  ui.dock.hidden = !show;
  if (!show) { ui.dock.innerHTML = ''; return; }

  if (ui.ask && data.me) {
    ui.dock.innerHTML = `
      <div class="pane ask">
        <div class="ask-top">
          <span class="ask-ic">${I.mic}</span>
          <div>
            <b>Sesli sohbet açılsın mı?</b>
            <p>Takım arkadaşlarınla konuşmak için mikrofonuna erişmemiz gerekiyor.
               Bas-konuş tuşuna (${esc(keyLabel(voice.pttKey))}) basmadıkça hiçbir ses gönderilmez.</p>
          </div>
        </div>
        <div class="ask-acts">
          <button class="btn" data-act="ask-no" tabindex="-1">Şimdi değil</button>
          <button class="btn primary" data-act="ask-yes" tabindex="-1">Mikrofona izin ver</button>
        </div>
      </div>`;
    bind(ui.dock);
    return;
  }

  const mates = voice.teammates();
  const speaking = mates.filter((m) => { const p = voice.peers.get(m.name); return p && p.speaking; });
  const [stTxt, stCls] = STATUS[voice.state] || STATUS.off;

  let capTxt;
  if (!data.me) capTxt = 'Ses için <b>giriş yap</b>';
  else if (!voice.micOn && voice.error) capTxt = `<span class="err">${esc(voice.error)}</span>`;
  else if (!voice.micOn) capTxt = 'Ses kapalı';
  else if (voice.state === 'live') capTxt = speaking.length ? '' : `${CHANNEL_NAME[voice.channel]} · <b>${mates.length + 1}</b>`;
  else capTxt = stTxt;

  const faces = speaking.slice(0, 3).map((m) => `<span class="av t${m.team} sp">${initial(m.name)}</span>`).join('');
  const micCls = `mic ${voice.micOn ? 'on' : ''} ${voice.transmitting ? 'tx' : ''}`;

  ui.dock.innerHTML = `
    <div class="pane">
      <div class="cap">
        <button class="${micCls}" data-act="${data.me ? 'mic' : 'login'}" tabindex="-1"
                title="${voice.micOn ? 'Sesi kapat' : 'Sesi aç'}">
          <span class="ring"></span>${voice.micOn ? I.mic : I.micOff}
        </button>
        ${faces ? `<div class="faces">${faces}</div>` : ''}
        ${capTxt ? `<span class="cap-txt">${capTxt}</span>` : ''}
        <button class="chev ${ui.open ? 'up' : ''}" data-act="toggle" tabindex="-1" title="Ayarlar">${I.chev}</button>
      </div>
      ${ui.open ? bodyHtml(stTxt, stCls, mates) : ''}
    </div>`;

  const mic = ui.dock.querySelector('.mic');
  if (mic) mic.style.setProperty('--l', voice.level.toFixed(2));
  bind(ui.dock);
}

function bodyHtml(stTxt, stCls, mates) {
  if (!data.me) {
    return `<div class="body"><div class="sec">
      <p class="note">Sesli sohbet için oyundaki hesabınla giriş yapman gerekiyor.</p>
      <div style="height:10px"></div>
      <button class="btn primary wide" data-act="login" tabindex="-1">Giriş yap</button>
    </div></div>`;
  }

  return `
  <div class="body">
    <div class="sec">
      <div class="head">
        <div><div class="title">Sesli sohbet</div><div class="room">${esc(where.room.name)}</div></div>
        <span class="badge ${voice.micOn ? stCls : ''}">${voice.micOn ? stTxt : 'Kapalı'}</span>
      </div>
      ${errorBox()}
      ${stateNote()}
      <div class="scope">
        <button data-act="scope" data-v="team" tabindex="-1" class="${voice.scope !== 'general' ? 'on' : ''}">
          <b>Özel</b><span>${voice.me && voice.me.team ? 'Takım arkadaşların' : 'İzleyicilerle'}</span>
        </button>
        <button data-act="scope" data-v="general" tabindex="-1" class="${voice.scope === 'general' ? 'on' : ''}">
          <b>Genel</b><span>Odada geçen herkes</span>
        </button>
      </div>
      <div class="lbl"><span class="chan ${voice.channel}"><i></i>${CHANNEL_NAME[voice.channel]}</span></div>
      <div class="mates">${matesHtml(mates)}</div>
    </div>

    <div class="sec">
      <div class="row">
        <span>Konuşma</span>
        <div class="seg">
          <button data-act="mode" data-v="ptt" tabindex="-1" class="${voice.mode === 'ptt' ? 'on' : ''}">Bas-konuş</button>
          <button data-act="mode" data-v="open" tabindex="-1" class="${voice.mode === 'open' ? 'on' : ''}">Açık</button>
        </div>
      </div>
      ${voice.mode === 'ptt' ? `
      <div class="row">
        <span>Tuş</span>
        <kbd data-act="key" tabindex="-1" class="${ui.pickKey ? 'wait' : ''}">${ui.pickKey ? 'Bir tuşa bas' : keyLabel(voice.pttKey)}</kbd>
      </div>` : ''}
      <div class="row">
        <span>Mikrofon</span>
        <select data-act="dev" tabindex="-1">${ui.devs.length
          ? ui.devs.map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === voice.deviceId ? 'selected' : ''}>${esc(d.label || 'Mikrofon')}</option>`).join('')
          : '<option>Varsayılan</option>'}</select>
      </div>
      <div class="row">
        <span>Giriş sesi</span>
        <input type="range" min="0" max="100" value="${Math.round(voice.inputGain * 100)}" data-act="in" tabindex="-1">
      </div>
      <div class="row">
        <span>Kulaklık</span>
        <input type="range" min="0" max="100" value="${Math.round(voice.outputGain * 100)}" data-act="out" tabindex="-1">
      </div>
    </div>

    <div class="sec">
      <div class="row">
        <span>Mikrofon testi</span>
        <button class="btn" data-act="test" tabindex="-1" ${voice.micOn ? '' : 'disabled'}>${voice.testOn ? 'Durdur' : 'Kendimi dinle'}</button>
      </div>
      <div class="meter"><i></i><b></b></div>
      <p class="note">${voice.testOn
        ? 'Kendi sesini duyuyorsun. Hoparlörle uğultu yapar; kulaklık tak.'
        : 'Konuşurken çubuk çizgiyi geçiyorsa mikrofonun duyuluyor.'}</p>
    </div>

    <div class="sec">
      <button class="btn wide ${voice.micOn ? 'danger' : 'primary'}" data-act="mic" tabindex="-1">
        ${voice.micOn ? 'Sesi kapat' : 'Sesi aç'}
      </button>
    </div>
  </div>`;
}

// Mikrofon açılamadıysa ne olduğunu ve ne yapılacağını söyle.
function errorBox() {
  if (voice.micOn || !voice.error) return '';
  const hint = {
    denied: IS_MAC
      ? 'Sistem Ayarları → Gizlilik ve Güvenlik → Mikrofon bölümünden Luxora Futsal\'a izin ver.'
      : 'Windows Ayarları → Gizlilik → Mikrofon bölümünde "Masaüstü uygulamalarının mikrofona erişmesine izin ver" açık olmalı.',
    missing: 'Bilgisayara bağlı bir mikrofon bulunamadı. Kulaklığını takıp tekrar dene.',
    busy: 'Mikrofonu kullanan başka bir uygulamayı (Discord gibi) kapatıp tekrar dene; ya da aşağıdan başka bir mikrofon seç.',
    other: 'Tekrar dene; olmazsa aşağıdan başka bir mikrofon seç.',
  }[voice.errorCode] || '';
  const settings = voice.errorCode === 'denied' && !IS_LINUX
    ? '<button class="btn" data-act="settings" tabindex="-1">Ayarları aç</button>' : '';
  return `<div class="errbox">
    <p><b>${esc(voice.error)}</b> ${esc(hint)}</p>
    <div class="acts">
      <button class="btn primary" data-act="retry" tabindex="-1">Tekrar dene</button>${settings}
    </div>
  </div>`;
}

// Neden henüz konuşulamadığını tek cümleyle söyle.
function stateNote() {
  if (!voice.micOn) return '';
  if (voice.state === 'no-name') {
    const hx = haxNick();
    return `<p class="note" style="margin-bottom:10px">Hesabın <b>${esc(data.me)}</b>${hx ? `, Haxball'daki adın <b>${esc(hx)}</b>` : ''}.
      İkisi aynı olmalı; Haxball'da adını hesabınla aynı yapıp odaya yeniden gir.</p>`;
  }
  if (voice.state === 'update') {
    return '<p class="note" style="margin-bottom:10px">Sesli sohbet için uygulamanın yeni sürümü gerekiyor. luxorafutsal.com\'dan ya da GitHub\'dan indir.</p>';
  }
  if (voice.state === 'replaced') {
    return '<p class="note" style="margin-bottom:10px">Hesabın sesli sohbete başka bir yerden bağlandı. Buradan konuşmak için sesi kapatıp yeniden aç.</p>';
  }
  if (voice.state === 'no-auth') {
    return '<p class="note" style="margin-bottom:10px">Oturumun doğrulanamadı. Çıkış yapıp yeniden giriş yap.</p>';
  }
  if (voice.state === 'no-server') {
    return '<p class="note" style="margin-bottom:10px">Ses sunucusuna ulaşılamıyor. İnternetin kesilmiş olabilir; yeniden deneniyor.</p>';
  }
  return '';
}

function matesHtml(mates) {
  if (!voice.inRoom) return '<p class="empty">Odada görünmüyorsun</p>';
  if (!mates.length) {
    return `<p class="empty">${voice.scope === 'general'
      ? 'Genel sohbete henüz kimse geçmedi'
      : 'Bu kanalda sesli sohbete katılan başka kimse yok'}</p>`;
  }

  const anyFailed = mates.some((m) => voice.gaveUpOn(m.name));
  return mates.map((m) => {
    const p = voice.peers.get(m.name);
    const st = !voice.micOn ? 'kapalı'
      : voice.gaveUpOn(m.name) ? 'bağlanamadı'
      : p ? p.state : 'bekliyor';
    const sp = p && p.speaking ? 'sp' : '';
    const muted = p && p.muted;
    const vol = Math.round((p ? p.volume : 1) * 100);
    return `
    <div class="mate ${sp}">
      <span class="av t${m.team} ${sp}">${initial(m.name)}</span>
      <div><div class="nm">${esc(m.name)}</div><div class="st">${esc(st)}</div></div>
      <button class="ic ${muted ? 'muted' : ''}" data-act="pmute" data-v="${esc(m.name)}" tabindex="-1"
              title="${muted ? 'Sesini aç' : 'Sesini kapat'}">${muted ? I.spkOff : I.spk}</button>
      <div class="vol">
        <input type="range" min="0" max="150" value="${vol}" data-act="pvol" data-v="${esc(m.name)}" tabindex="-1">
        <span>${muted ? 'kapalı' : vol + '%'}</span>
      </div>
    </div>`;
  }).join('') + (anyFailed
    ? '<p class="note" style="margin-top:8px">Doğrudan bağlantı kurulamadı. Bu genelde modem veya operatör ayarlarından olur; sende bir arıza yok.</p>'
    : '');
}

function keyLabel(code) {
  return String(code || '').replace(/^Key|^Digit/, '').replace('Space', 'Boşluk').toUpperCase() || '—';
}

// ── Giriş kartı ──────────────────────────────────────────────────────────────

function renderLogin() {
  ui.veil.hidden = !ui.login;
  if (!ui.login) { ui.veil.innerHTML = ''; return; }
  if (ui.veil.querySelector('form')) {
    // Açık formu yeniden çizip yazılanı silme; yalnızca hata ve düğmeyi güncelle.
    const e = ui.veil.querySelector('.err');
    e.textContent = ui.loginErr; e.hidden = !ui.loginErr;
    const b = ui.veil.querySelector('[type=submit]');
    b.disabled = ui.busy; b.textContent = ui.busy ? 'Kontrol ediliyor…' : 'Giriş yap';
    return;
  }
  ui.veil.innerHTML = `
    <form class="card" autocomplete="off">
      <h2>Giriş yap</h2>
      <p>Sesli sohbet, Luxora odalarında takım arkadaşlarınla konuşmanı sağlar. Oyunda kullandığın hesapla gir.</p>
      <label class="field"><span>Kullanıcı adı</span><input name="nick" maxlength="40" spellcheck="false" autocomplete="off" value="${esc(lastNick())}"></label>
      <label class="field"><span>Şifre</span><input name="pass" type="password" maxlength="64" autocomplete="off"></label>
      <p class="err" hidden></p>
      <div class="acts">
        <button class="btn" type="button" data-act="login-cancel" tabindex="-1">Vazgeç</button>
        <button class="btn primary" type="submit">Giriş yap</button>
      </div>
      <p class="foot">Hesabın yoksa bir Luxora odasında sohbete <code>!kayit şifren</code> yaz.</p>
    </form>`;
  const form = ui.veil.querySelector('form');
  form.addEventListener('submit', onLoginSubmit);
  bind(ui.veil);
  // Ad zaten doluysa imleç doğrudan şifreye gitsin.
  setTimeout(() => {
    const nick = form.querySelector('[name=nick]');
    (nick && nick.value ? form.querySelector('[name=pass]') : nick).focus();
  }, 30);
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const f = e.currentTarget;
  const nick = f.nick.value.trim();
  const pass = f.pass.value;
  if (!nick || !pass) { ui.loginErr = 'Kullanıcı adı ve şifre gerekli.'; return renderLogin(); }

  ui.busy = true; ui.loginErr = ''; renderLogin();
  let r = null;
  try { r = await ipcRenderer.invoke('auth:login', { nick, password: pass }); } catch {}
  ui.busy = false;

  if (!r || !r.ok) {
    ui.loginErr = (r && r.error) || 'Giriş yapılamadı.';
    f.pass.value = '';
    renderLogin();
    f.pass.focus();
    return;
  }
  // Kabuk da haberdar oluyor (ana süreç bildiriyor); kimlik bir sonraki
  // canlı veriyle de gelecek ama beklemeden devam ediyoruz.
  data.me = r.me.nick;
  try { localStorage.setItem(NICK_KEY, r.me.nick); } catch {}
  skipNickScreen(frameDoc());
  closeLogin();
  if (where.room) activate();
}

// Ad kutusu: önce son giriş yapılan ad, yoksa Haxball'da seçili ad (hesapla
// aynı olması gerekiyor zaten).
function lastNick() {
  try { return localStorage.getItem(NICK_KEY) || haxNick(); } catch { return haxNick(); }
}

function openLogin() { build(); ui.login = true; ui.loginErr = ''; renderLogin(); }
function closeLogin() { if (!ui) return; ui.login = false; renderLogin(); refocusGame(); }

// ── Uyarı ────────────────────────────────────────────────────────────────────

function toast(title, text) {
  build();
  ui.toast.innerHTML = `
    <span class="t-ic">${I.warn}</span>
    <div class="t-txt"><b>${esc(title)}</b>${esc(text)}</div>
    <button class="ic" data-act="toast-x" tabindex="-1" title="Kapat">${I.x}</button>`;
  bind(ui.toast);
  ui.toast.hidden = false;
  requestAnimationFrame(() => ui.toast.classList.add('show'));
  clearTimeout(ui.toastT);
  ui.toastT = setTimeout(hideToast, 7000);
}

function hideToast() {
  if (!ui) return;
  ui.toast.classList.remove('show');
  clearTimeout(ui.toastT);
  setTimeout(() => { if (ui && !ui.toast.classList.contains('show')) ui.toast.hidden = true; }, 220);
}

// ── Etkileşim ────────────────────────────────────────────────────────────────

function bind(scope) {
  scope.querySelectorAll('[data-act]').forEach((el) => {
    const ev = el.tagName === 'INPUT' ? 'input' : el.tagName === 'SELECT' ? 'change' : 'click';
    el.addEventListener(ev, onAction);
  });
}

async function onAction(e) {
  const el = e.currentTarget;
  const act = el.dataset.act;
  const v = el.dataset.v;

  switch (act) {
    case 'toggle': ui.open = !ui.open; if (ui.open) loadDevices(); render(); break;
    case 'login': openLogin(); return;
    case 'login-cancel': closeLogin(); return;
    case 'toast-x': hideToast(); break;
    case 'mic':
      if (voice.micOn) { setUserOff(true); voice.disableMic(); }
      else { setConsent('yes'); setUserOff(false); ui.ask = false; await startMic(); }
      break;
    case 'ask-yes': setConsent('yes'); setUserOff(false); ui.ask = false; render(); await startMic(); break;
    case 'ask-no': ui.ask = false; ui.declined = true; render(); break;
    case 'retry': await startMic(); break;
    case 'settings': ipcRenderer.send('open:mic-settings'); break;
    case 'mode': voice.setMode(v); break;
    case 'scope':
      try { localStorage.setItem(SCOPE_KEY, v === 'general' ? 'general' : 'team'); } catch {}
      voice.setScope(v);
      break;
    case 'key': ui.pickKey = !ui.pickKey; render(); return;   // tuş beklerken odak burada kalsın
    case 'dev': voice.setDevice(el.value); break;
    case 'test': voice.toggleTest(); break;
    // Kaydırmaçlar paneli yeniden çizmiyor: sürükleme kopardı. Etiket elden.
    case 'in': voice.setInputGain(Number(el.value) / 100); return touch();
    case 'out': voice.setOutputGain(Number(el.value) / 100); return touch();
    case 'pvol': {
      const vol = Number(el.value);
      voice.setPeerVolume(v, vol / 100);
      const lbl = el.parentElement.querySelector('span');
      const p = voice.peers.get(v);
      if (lbl) lbl.textContent = p && p.muted ? 'kapalı' : `${vol}%`;
      return touch();
    }
    case 'pmute': voice.togglePeerMute(v); break;
  }
  if (el.blur) el.blur();
  refocusGame();
  touch();
}

// Paneldeki bir düğmeye basınca odak oyundan çıkıyor; oyuncu fark etmeden
// klavyesiz kalmasın diye odak hemen oyuna geri veriliyor.
function refocusGame() {
  if (ui && (ui.login || ui.pickKey)) return;
  try { const f = frameEl(); if (f) f.contentWindow.focus(); } catch {}
}

async function loadDevices() {
  if (!ui) return;
  ui.devs = await voice.devices();
  render();
}

// Kapsül bir süre dokunulmazsa soluyor; açık panel solmuyor.
function touch() {
  if (!ui) return;
  ui.dock.classList.remove('idle');
  clearTimeout(ui.idle);
  if (ui.open) return;
  ui.idle = setTimeout(() => ui && !ui.open && ui.dock.classList.add('idle'), 4000);
}

// ── Konum: sürükle, köşeye yapış, hatırla ───────────────────────────────────

function restorePos() {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (p) Object.assign(ui.dock.style, p);
  } catch {}
}

function wireDrag() {
  let drag = null;
  ui.dock.addEventListener('pointerdown', (e) => {
    const t = e.composedPath()[0];
    if (!t.closest || !t.closest('.cap') || t.closest('button')) return;
    const r = ui.dock.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    ui.dock.setPointerCapture(e.pointerId);
  });
  ui.dock.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const w = ui.dock.offsetWidth, h = ui.dock.offsetHeight;
    Object.assign(ui.dock.style, {
      left: `${Math.max(8, Math.min(innerWidth - w - 8, e.clientX - drag.dx))}px`,
      top: `${Math.max(8, Math.min(innerHeight - h - 8, e.clientY - drag.dy))}px`,
      right: 'auto', bottom: 'auto',
    });
  });
  ui.dock.addEventListener('pointerup', (e) => {
    if (!drag) return;
    drag = null;
    ui.dock.releasePointerCapture(e.pointerId);
    snap();
  });
}

// En yakın köşeye yapıştır — katman sahanın ortasında unutulmasın.
function snap() {
  const r = ui.dock.getBoundingClientRect();
  const left = r.left + r.width / 2 < innerWidth / 2;
  const top = r.top + r.height / 2 < innerHeight / 2;
  const pos = {
    left: left ? '12px' : 'auto', right: left ? 'auto' : '12px',
    top: top ? '12px' : 'auto', bottom: top ? 'auto' : '12px',
  };
  Object.assign(ui.dock.style, pos);
  try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch {}
}

// ── Klavye ───────────────────────────────────────────────────────────────────
// Hem üst sayfaya hem oyun çerçevesine takılıyor. Oyunun kendi tuşlarına
// (Tab/Enter sohbet, Esc oda menüsü, ok tuşları, X) dokunulmuyor.

const typing = (e) => {
  const t = e.composedPath ? e.composedPath()[0] : e.target;
  return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
};

function onKeyDown(e) {
  if (e.key === 'F11') { e.preventDefault(); ipcRenderer.send('win:action', 'full'); return; }
  // Yeniden yükleme oyuncuyu odadan düşürür.
  if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'))) { e.preventDefault(); return; }

  if (ui && ui.pickKey) {
    if (e.key === 'Escape') { ui.pickKey = false; render(); refocusGame(); return; }
    e.preventDefault();
    voice.setPttKey(e.code);
    ui.pickKey = false;
    render();
    refocusGame();
    return;
  }
  if (ui && ui.login && e.key === 'Escape') { closeLogin(); return; }
  // Sohbete yazarken bas-konuş tetiklenmesin.
  if (typing(e)) return;
  if (voice.onKey(e, true)) touch();
}

function onKeyUp(e) {
  if (typing(e)) return;
  voice.onKey(e, false);
}

// Tuş basılıyken pencere odağı kaçarsa (Alt+Tab gibi) keyup hiç gelmez ve
// mikrofon açık kalırdı. Odak kaybında bas-konuş bırakılıyor.
const releasePtt = () => voice.onKey({ code: voice.pttKey }, false);

let hooked = null;
function hookFrame() {
  const f = frameEl();
  let w = null;
  try { w = f && f.contentWindow; } catch {}
  if (!w || hooked === w) return;
  try {
    w.addEventListener('keydown', onKeyDown, true);
    w.addEventListener('keyup', onKeyUp, true);
    w.addEventListener('blur', releasePtt);
    hooked = w;
  } catch {}
}

window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('keyup', onKeyUp, true);
window.addEventListener('blur', releasePtt);
window.addEventListener('resize', () => { if (ui && !ui.dock.hidden) snap(); });

// ── Kabuktan gelenler ────────────────────────────────────────────────────────

// Canlı oda listesi ve giriş durumu. Oda bilgisi buradan eşleştiriliyor,
// takım bilgisi de buradan güncelleniyor.
ipcRenderer.on('voice:room', (_e, d) => {
  if (!d) return;
  data.rooms = Array.isArray(d.rooms) ? d.rooms : [];
  const wasMe = data.me;
  // Kabuk açılışta oturumu henüz bilmiyorsa 'me' göndermiyor. Eskiden bu
  // boşluk "çıkış yapıldı" sanılıp mikrofon kapatılıyordu.
  if ('me' in d) data.me = d.me || null;
  if (d.ice) voice.setIce(d.ice);
  if (!wasMe && data.me) skipNickScreen(frameDoc());

  if (where.inRoom && where.name && isLuxoraName(where.name)) {
    const r = matchRoom(where.name);
    if (r) {
      const first = !where.room;
      where.room = r;
      if (first || (!wasMe && data.me)) activate();
      else voice.setRoom({ id: r.id, name: r.name }, r.players || []);
    }
  }
  // Çıkış yapıldıysa ses kapanır.
  if (wasMe && !data.me) stopVoice();
  render();
});

ipcRenderer.on('voice:login', () => openLogin());
ipcRenderer.on('voice:off', () => { stopVoice(); if (ui) { ui.host.remove(); ui = null; } });

let frame = 0;
voice.addEventListener('level', () => {
  if (!ui) return;
  const m = ui.dock.querySelector('.mic');
  if (m) m.style.setProperty('--l', voice.level.toFixed(2));
  const f = ui.dock.querySelector('.meter i');
  if (f) f.style.width = `${Math.min(100, voice.level * 100).toFixed(0)}%`;
  if (++frame % 15 === 0) report();
});
voice.addEventListener('change', () => { render(); touch(); report(); });
voice.addEventListener('peers', () => render());

function report() {
  ipcRenderer.send('voice:status', {
    room: where.room ? where.room.name : null,
    lux: !!where.room,
    state: voice.state, mic: voice.micOn, tx: voice.transmitting,
    peers: voice.peers.size,
  });
}

// Geliştirme kancası — yalnızca LUX_DEV ayarlıyken.
if (process.env.LUX_DEV) {
  window.__lux = { voice, render, ui: () => ui, build, where, data, onEnter, onLeave, toast, openLogin };
}

// Haxball'un kendi FPS sınırı (oyunun ayarlarında). Sıfır "sınırsız" demek:
// oyun ekranın yenileme hızı kadar çizer (300 Hz ekranda 300 FPS). Oyun bu
// ayarı açılışta okuduğu için sayfanın betiklerinden önce, burada sıfırlanıyor.
try { localStorage.setItem('fps_limit', '0'); } catch {}

function start() {
  build();
  setInterval(detect, 700);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
