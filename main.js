// Luxora Futsal masaüstü istemcisi — ana süreç.
//
// Pencere çerçevesiz: başlık çubuğunu kendimiz çiziyoruz (renderer/index.html).
// Oyun, arayüzün içine gömülü ayrı bir WebContentsView olarak açılır; oyunun
// sayfasına hiç dokunmayız, yalnızca etrafına kendi arayüzümüzü koyarız.
//
// ÖNEMLİ — yerleşim kısıtı: WebContentsView, HTML'in ÜSTÜNDE çizilir. Oyunun
// üzerine HTML ile bir şey bindiremeyiz. Bu yüzden ses paneli oyunun üstünde
// yüzen bir kutu değil, sağda kendi yerini kaplayan bir sütun. Oyun görünümü
// de tam olarak ortada kalan boşluğa oturtulur (renderer `stage:bounds` ile
// ölçüp bildirir).

const { app, BrowserWindow, WebContentsView, ipcMain, shell, session, net, Menu, systemPreferences } = require('electron');

// Mac'te pencere düğmeleri (sol üstteki üç nokta) işletim sisteminin; Windows
// ve Linux'ta kendi düğmelerimiz çiziliyor.
const IS_MAC = process.platform === 'darwin';
const path = require('path');

// Odalarımızın linkleri luxorafutsal.com'dan geliyor; oyun ise haxball.com'da
// açılıyor. Başka hiçbir adrese gitmesine izin vermiyoruz.
const SITE = 'https://luxorafutsal.com';
const GAME_HOSTS = new Set(['www.haxball.com', 'haxball.com']);

let win = null;
let gameView = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    // Mac: yerel başlık çubuğu gizli ama düğmeleri yerinde (hiddenInset).
    // Diğerleri: çerçevesiz, düğmeleri kabuk çiziyor.
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 15 } }
      : { frame: false }),
    backgroundColor: '#03040a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Açılış videosu sesiyle birlikte kullanıcı tıklamadan başlasın.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Arayüzün kendisi başka bir adrese gitmeye kalkmasın; dış bağlantılar
  // kullanıcının kendi tarayıcısında açılsın.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Tam ekran ve büyütme durumu arayüze bildiriliyor: üst çubuk tam ekranda
  // gizleniyor ve oyun pencerenin tamamını kaplıyor.
  const state = () => send('win:state', {
    full: win.isFullScreen(), max: win.isMaximized(),
  });
  ['enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize'].forEach((ev) => win.on(ev, state));

  // Pencereye geri dönülünce odak yine oyuna.
  win.on('focus', focusGame);

  win.on('closed', () => { win = null; gameView = null; });
}

// ── Oyun görünümü ────────────────────────────────────────────────────────────

function ensureGameView() {
  if (gameView) return gameView;

  // Ayrı bir oturum: oyuncunun Haxball tarafındaki adı/ayarı uygulamayı
  // kapatınca kaybolmasın.
  const part = session.fromPartition('persist:haxball');

  // Ses katmanı oyunun sayfasına enjekte ediliyor (game-preload.js). Oyun
  // görünümü HTML'in üstünde çizildiği için panelin oyunun üstünde durmasının
  // tek yolu bu; yandan sütun açmak oyuncunun alanını yerdi.
  // Mac mikrofonu işletim sistemi izni olmadan hiç açmıyor; izin penceresi
  // ilk istekte burada çıkıyor. (Info.plist'teki açıklama package.json'da.)
  part.setPermissionRequestHandler((_wc, perm, done) => {
    if (perm !== 'media') return done(false);
    if (!IS_MAC) return done(true);
    systemPreferences.askForMediaAccess('microphone').then(done).catch(() => done(false));
  });
  part.setPermissionCheckHandler((_wc, perm) => perm === 'media');

  gameView = new WebContentsView({
    webPreferences: {
      session: part,
      preload: path.join(__dirname, 'game-preload.js'),
      contextIsolation: false,   // panel kendi shadow DOM'unda; sayfa ile karışmıyor
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
      // Pencere arka plandayken ya da giriş kartı açıkken oyun yavaşlamasın:
      // Chromium arka plandaki sayfanın zamanlayıcılarını kısıyor, bu da
      // Haxball'da takılma ve kopma demek.
      backgroundThrottling: false,
    },
  });
  gameView.setBackgroundColor('#0b0a10');

  const wc = gameView.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Oyun görünümü yalnızca Haxball'da kalır. Reklam ya da yanlış bir tıklama
  // uygulamayı başka bir siteye taşımasın.
  //
  // Yalnızca oyun sayfasının (/play) kendisine izin var. Haxball sayfasının
  // üstündeki News/About/Community bağlantıları da haxball.com'da; onlara
  // izin verilseydi maç ortasında yanlış bir tıklama sayfayı değiştirip
  // oyuncuyu odadan düşürürdü. Bu bağlantılar kullanıcının tarayıcısında açılır.
  wc.on('will-navigate', (e, url) => {
    try {
      const u = new URL(url);
      if (!GAME_HOSTS.has(u.hostname) || u.pathname !== '/play') {
        e.preventDefault();
        if (/^https?:$/.test(u.protocol)) shell.openExternal(url);
      }
    } catch { e.preventDefault(); }
  });

  // Sayfa yüklenince klavye odağı OYUNA verilir. Verilmezse odak kabukta
  // kalıyor, basılan tuşlar oyuna değil kabuğa gidiyordu — Tab ve Esc'nin
  // "ekranı götürmesi" buradan çıkıyordu.
  wc.on('did-finish-load', () => { send('game:loaded'); focusGame(); });
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) send('game:failed', { code, desc });
  });

  return gameView;
}

function focusGame() {
  if (gameView && win && !win.isDestroyed() && win.contentView.children.includes(gameView)) {
    gameView.webContents.focus();
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function attachGame(url) {
  const view = ensureGameView();
  if (!win.contentView.children.includes(view)) win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); // ölçü gelene kadar görünmesin
  view.webContents.loadURL(url);
}

function detachGame() {
  if (!gameView || !win) return;
  try { gameView.webContents.send('voice:off'); } catch {}
  if (win.contentView.children.includes(gameView)) win.contentView.removeChildView(gameView);
  // Odadan çıkınca oyun arka planda çalışmaya devam etmesin.
  gameView.webContents.loadURL('about:blank');
}

// ── Ses katmanı ile kabuk arasındaki köprü ───────────────────────────────────
// Oda ve kadro bilgisi kabuktan (canlı veri) geliyor, ses katmanı onu kullanıp
// kimin kiminle konuşacağını biliyor. Ses verisi buradan geçmez.

// Aktarıcı (TURN) bilgileri siteden alınıyor: kısa ömürlü ve yalnızca giriş
// yapmış oyunculara veriliyor, bu yüzden isteği oturumu olan ana süreç atıyor.
// Alınamazsa ses sistemi STUN ile çalışmaya devam eder.
let iceCache = { at: 0, list: null };

async function iceServers() {
  if (iceCache.list && Date.now() - iceCache.at < 25 * 60e3) return iceCache.list;
  const r = await api('/voice/ice');
  const list = r.status === 200 && r.data && Array.isArray(r.data.iceServers) ? r.data.iceServers : null;
  if (list) iceCache = { at: Date.now(), list };
  return list;
}

ipcMain.on('voice:room', async (_e, data) => {
  if (!gameView || gameView.webContents.isDestroyed()) return;
  let ice = null;
  try { ice = await iceServers(); } catch {}
  if (gameView && !gameView.webContents.isDestroyed()) {
    gameView.webContents.send('voice:room', { ...data, ice });
  }
});

ipcMain.on('voice:status', (_e, s) => send('voice:status', s));

// Üst çubuktaki "Giriş yap": form oyunun üstündeki katmanda açılıyor, çünkü
// kabuğun çizdiği hiçbir şey oyun görünümünün üstüne çıkamaz.
ipcMain.on('voice:login', () => {
  if (gameView && !gameView.webContents.isDestroyed()) {
    gameView.webContents.send('voice:login');
    focusGame();
  }
});

// ── Arayüzden gelen istekler ─────────────────────────────────────────────────

ipcMain.handle('game:open', (_e, { url }) => {
  let ok = false;
  try { ok = GAME_HOSTS.has(new URL(url).hostname); } catch {}
  if (!ok) return { ok: false, error: 'bad_url' };
  attachGame(url);
  return { ok: true };
});

ipcMain.handle('game:close', () => { detachGame(); return { ok: true }; });
ipcMain.on('game:focus', focusGame);

// Renderer, oyunun oturacağı boşluğu ölçüp buraya yollar.
ipcMain.on('game:bounds', (_e, r) => {
  if (!gameView || !win || win.isDestroyed()) return;
  if (!win.contentView.children.includes(gameView)) return;
  gameView.setBounds({
    x: Math.round(r.x), y: Math.round(r.y),
    width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)),
  });
});

ipcMain.on('win:action', (_e, what) => {
  if (!win) return;
  if (what === 'min') win.minimize();
  else if (what === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (what === 'close') win.close();
  else if (what === 'full') win.setFullScreen(!win.isFullScreen());
  else if (what === 'unfull') { if (win.isFullScreen()) win.setFullScreen(false); }
});

// ── Giriş ────────────────────────────────────────────────────────────────────
//
// İstekler ANA SÜREÇTEN atılıyor, arayüzden değil. İki sebebi var: arayüzün
// kaynağı file:// olduğu için tarayıcı kuralları (CORS) araya girerdi; ve
// oturum çerezi arayüzün erişemediği ayrı bir kavanozda durur. Şifre hiçbir
// yere yazılmıyor, yalnızca bu istekte geçiyor.
//
// Site POST'ları kendi sayfasından geliyor mu diye bakıyor (x-lux başlığı +
// Origin). İstemci de aynı sayfanın yerine geçtiği için aynı başlıkları yolluyor.

let authSession = null;
let me = null;

const authSess = () => (authSession || (authSession = session.fromPartition('persist:lux')));

async function api(path, { method = 'GET', body = null } = {}) {
  try {
    const res = await net.fetch(SITE + path, {
      method,
      headers: {
        'x-lux': '1',
        origin: SITE,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      session: authSess(),
      credentials: 'include',
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: null, net: e.message };
  }
}

const LOGIN_ERRORS = {
  credentials: 'Kullanıcı adı veya şifre yanlış.',
  locked: 'Çok fazla yanlış deneme. 15 dakika bekle.',
  rate: 'Çok fazla deneme oldu, biraz bekle.',
  server: 'Sunucuya şu an ulaşılamıyor.',
  offline: 'Sunucuya şu an ulaşılamıyor.',
};

ipcMain.handle('auth:login', async (_e, { nick, password }) => {
  const r = await api('/api/login', { method: 'POST', body: { nick, password } });
  if (r.status === 0) return { ok: false, error: 'İnternet bağlantısı yok.' };
  if (r.status === 200 && r.data && r.data.ok) {
    me = { nick: r.data.nick };
    await refreshMe();
    // Giriş oyun katmanından da yapılabiliyor; kabuk üst çubuğu güncellesin.
    send('auth:changed', me);
    return { ok: true, me };
  }
  const code = (r.data && r.data.error) || '';
  return { ok: false, error: LOGIN_ERRORS[code] || 'Giriş yapılamadı.' };
});

// Oturum çerezi kalıcı; uygulama yeniden açıldığında giriş istemeden devam eder.
async function refreshMe() {
  const r = await api('/api/me');
  if (r.status === 200 && r.data && r.data.me) {
    const p = r.data.me;
    me = {
      nick: p.nick || (me && me.nick) || '',
      points: p.points ?? null, rank: p.rank || null,
      vip: !!p.vip, position: p.position || null,
    };
    return me;
  }
  if (r.status === 401 || r.status === 403) me = null;
  return me;
}

ipcMain.handle('auth:me', async () => (await refreshMe()) || null);
ipcMain.handle('auth:current', () => me);

ipcMain.handle('auth:logout', async () => {
  await api('/api/logout', { method: 'POST', body: {} });
  me = null;
  iceCache = { at: 0, list: null };   // aktarıcı bilgileri oturuma bağlı
  send('auth:changed', null);
  return { ok: true };
});

ipcMain.handle('app:info', () => ({ site: SITE, version: app.getVersion(), platform: process.platform }));

ipcMain.on('open:external', (_e, url) => {
  if (/^https:\/\//.test(String(url))) shell.openExternal(url);
});

// ── Yaşam döngüsü ────────────────────────────────────────────────────────────

// Aynı anda tek pencere. Oyuncu uygulamayı ikinci kez açarsa yenisi kapanır,
// var olan pencere öne gelir. İki kopya aynı profili paylaşıp önbelleği
// kilitliyor ve iki ayrı Haxball oturumu açılıyordu.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  if (!gotLock) return;
  // Varsayılan menü kaldırılıyor. Görünmez olsa da kısayolları çalışıyordu:
  // Ctrl+R sayfayı yeniden yükler (yani oyuncuyu odadan düşürür), Ctrl+W
  // pencereyi kapatır. Maçın ortasında yanlış tuşla olacak iş değil.
  //
  // Mac istisna: orada kopyala/yapıştır (Cmd+C/V) ve çıkış (Cmd+Q) menü
  // üzerinden çalışıyor; menü tamamen kalkarsa giriş formuna şifre bile
  // yapıştırılamaz. Mac'e yalnızca uygulama ve düzen menüsü veriliyor —
  // yeniden yükleme içeren görünüm menüsü yok.
  Menu.setApplicationMenu(IS_MAC
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
    : null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
