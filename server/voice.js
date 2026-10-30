// Sesli iletişim işaretleşmesi — Cloudflare Workers üzerinde, oda başına bir
// Durable Object.
//
// NE TAŞIR — yalnızca "kim hangi kanalda" bilgisi ve eşlerin birbirine
// bağlanmak için ihtiyaç duyduğu teklif/yanıt/aday mesajları. SES BURADAN
// GEÇMEZ: ses oyuncudan oyuncuya doğrudan gider (WebRTC mesh).
//
// KANALLAR — her oyuncu aynı anda tek bir kanaldadır:
//   red / blue  takımın özel kanalı
//   spec        izleyicilerin özel kanalı
//   general     odanın genel kanalı: odadaki herkes geçebilir
// Mesajlar yalnızca AYNI KANALDAKİLER arasında iletilir.
//
// GÜVENLİK — istemciye hiçbir konuda güvenilmez:
//   • Kimlik: bağlanan, siteden aldığı tek kullanımlık bir ses bileti
//     sunar. Bileti site (Hub) yalnızca giriş yapmış oyuncuya, kendi hesabı
//     ve tek bir oda için verir. Adı istemci değil SUNUCU belirler.
//   • Oda: hesap o odanın canlı kadrosunda değilse bağlantı reddedilir.
//   • Takım: özel kanal her zaman kadrodaki gerçek takımdan türetilir;
//     istemcinin söylediği takım yok sayılır. Takım değişirse sunucu kanalı
//     kendisi düzeltir, odadan çıkanı sesten çıkarır.
// Eskiden kimlik ve takım istemcinin beyanıydı: herkes başkasının adıyla
// bağlanıp onu düşürebiliyor, rakip takımın özel kanalını dinleyebiliyordu.

const MAX_PER_ROOM = 24;            // bir odada aynı anda en fazla kaç ses bağlantısı
const MAX_MSG = 16 * 1024;          // tek mesaj üst sınırı (SDP birkaç KB sürer)
const MSG_BURST = 400;              // 10 sn'de en fazla mesaj (ICE adayları dahil)
const HELLO_TIMEOUT_MS = 10_000;    // kimlik bu sürede gelmezse bağlantı kapanır
const RECHECK_MS = 8_000;           // takım/oda doğrulaması aralığı
const ORIGINS = new Set(['https://www.haxball.com', 'https://haxball.com', 'https://luxorafutsal.com']);

// Kapanış kodları istemciye ne olduğunu söyler.
const CLOSE = {
  hello: [4000, 'hello first'],
  bad: [4001, 'bad hello'],
  full: [4002, 'full'],
  replaced: [4003, 'replaced'],
  notInRoom: [4004, 'not in room'],
  token: [4005, 'invalid token'],
  flood: [4008, 'too many messages'],
  update: [4010, 'client update required'],
};

const teamChannel = (team) => (team === 1 ? 'red' : team === 2 ? 'blue' : 'spec');

const close = (ws, [code, why]) => { try { ws.close(code, why); } catch {} };
const send = (ws, m) => { try { ws.send(JSON.stringify(m)); } catch {} };

export class VoiceRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
    this.peers = new Map();     // name -> { ws, team, channel, general }
    this.timer = null;
  }

  // Kimlik ve kadro bilgisi Hub'da (site verisinin tek kaynağı). Bu çağrılar
  // dışarıdan erişilemeyen iç yollardan yapılır.
  async hub(path, body) {
    try {
      const stub = this.env.HUB.get(this.env.HUB.idFromName('main'));
      const r = await stub.fetch('https://hub.internal' + path, { method: 'POST', body: JSON.stringify(body) });
      return await r.json();
    } catch {
      return { ok: false, error: 'hub' };
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    // Tarayıcılar Origin'i gönderir: başka bir web sitesi bu sunucuyu
    // ziyaretçisinin üzerinden kullanamasın. (Asıl koruma ses biletidir.)
    const origin = request.headers.get('Origin');
    if (origin && !ORIGINS.has(origin)) return new Response('forbidden', { status: 403 });

    this.room = new URL(request.url).searchParams.get('room');
    const pair = new WebSocketPair();
    this.accept(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  accept(ws) {
    ws.accept();
    const conn = { me: null, busy: false, count: 0, since: Date.now() };
    const helloTimer = setTimeout(() => { if (!conn.me) close(ws, CLOSE.hello); }, HELLO_TIMEOUT_MS);

    ws.addEventListener('message', (ev) => {
      // Her hata yakalanır: işlenmeyen bir hata nesneyi, yani o odadaki
      // herkesin sesini düşürebilirdi.
      this.onMessage(ws, conn, ev).catch(() => close(ws, CLOSE.bad));
    });

    let gone = false;
    const bye = () => {
      if (gone) return;
      gone = true;
      clearTimeout(helloTimer);
      const me = conn.me;
      if (!me) return;
      const mine = this.peers.get(me.name);
      if (mine && mine.ws === ws) {
        this.peers.delete(me.name);
        this.announce(mine.channel, me.name);
      }
      if (!this.peers.size) this.stopRecheck();
    };
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);
  }

  async onMessage(ws, conn, ev) {
    if (typeof ev.data !== 'string' || ev.data.length > MAX_MSG) return;

    // Mesaj seli: 10 saniyede MSG_BURST'ten fazlası bağlantıyı kapatır.
    const now = Date.now();
    if (now - conn.since > 10_000) { conn.since = now; conn.count = 0; }
    if (++conn.count > MSG_BURST) return close(ws, CLOSE.flood);

    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (!conn.me) return this.onHello(ws, conn, m);

    if (m.type === 'channel') return this.onChannel(ws, conn, m);

    // Eşler arası yönlendirme: yalnız aynı kanaldakiler arasında. Gönderen
    // adını sunucu yazar; istemcinin "from" alanı yok sayılır.
    if (!['offer', 'answer', 'ice'].includes(m.type)) return;
    const mine = this.peers.get(conn.me.name);
    if (!mine || mine.ws !== ws) return;
    const target = this.peers.get(String(m.to || '').slice(0, 40));
    if (!target || target.channel !== mine.channel) return;
    const out = { type: m.type, from: conn.me.name };
    if (m.type === 'ice') out.ice = m.ice; else out.sdp = String(m.sdp || '');
    send(target.ws, out);
  }

  async onHello(ws, conn, m) {
    if (conn.busy) return;   // kimlik doğrulanırken gelen diğer mesajlar yok sayılır
    if (m.type !== 'hello') return close(ws, CLOSE.hello);
    // Eski istemciler bilet göndermiyor; güncellemeleri gerekiyor.
    if (typeof m.token !== 'string' || !m.token) return close(ws, CLOSE.update);
    if (!/^[a-z0-9_-]{1,32}$/i.test(this.room || '')) return close(ws, CLOSE.bad);

    conn.busy = true;
    const v = await this.hub('/__voice/verify', { token: m.token.slice(0, 128), room: this.room });
    conn.busy = false;
    if (!v.ok) return close(ws, v.error === 'not_in_room' ? CLOSE.notInRoom : CLOSE.token);

    const name = String(v.nick);
    const team = Number(v.team) || 0;
    if (this.peers.size >= MAX_PER_ROOM && !this.peers.has(name)) return close(ws, CLOSE.full);

    // Aynı hesap ikinci kez bağlanırsa (yeniden bağlanma, ikinci cihaz) eski
    // bağlantı kapanır. Artık bunu yalnız hesabın sahibi yapabilir: bilet
    // oturumdan geliyor.
    const old = this.peers.get(name);
    if (old) { this.peers.delete(name); close(old.ws, CLOSE.replaced); this.announce(old.channel, name); }

    const general = m.channel === 'general';
    const channel = general ? 'general' : teamChannel(team);
    conn.me = { name };
    this.peers.set(name, { ws, team, channel, general });
    send(ws, { type: 'welcome', name, channel, team });
    this.announce(channel);
    this.startRecheck();
  }

  // Özel ↔ genel geçişi. Özel kanal istemcinin dediğinden değil, kadrodaki
  // güncel takımdan belirlenir.
  async onChannel(ws, conn, m) {
    const mine = this.peers.get(conn.me.name);
    if (!mine || mine.ws !== ws) return;
    mine.general = m.channel === 'general';
    if (!mine.general) {
      const t = await this.hub('/__voice/team', { room: this.room, nick: conn.me.name });
      if (!t.ok) { this.peers.delete(conn.me.name); this.announce(mine.channel, conn.me.name); return close(ws, CLOSE.notInRoom); }
      mine.team = Number(t.team) || 0;
    }
    this.move(conn.me.name, mine.general ? 'general' : teamChannel(mine.team));
  }

  move(name, next) {
    const p = this.peers.get(name);
    if (!p || p.channel === next) {
      if (p) send(p.ws, { type: 'welcome', name, channel: p.channel, team: p.team });
      return;
    }
    const prev = p.channel;
    p.channel = next;
    send(p.ws, { type: 'welcome', name, channel: next, team: p.team });
    this.announce(prev, name);
    this.announce(next);
  }

  // Kadroyla periyodik hizalama: takım değiştiren doğru kanala taşınır,
  // odadan çıkan sesten çıkarılır. İstemci haber vermese bile.
  startRecheck() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.recheck().catch(() => {}); }, RECHECK_MS);
  }

  stopRecheck() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async recheck() {
    if (!this.peers.size) return this.stopRecheck();
    const r = await this.hub('/__voice/roster', { room: this.room });
    if (!r.ok) return;   // Hub geçici olarak cevap vermediyse kimseyi atma
    const teams = new Map((r.players || []).map((p) => [String(p.key), Number(p.team) || 0]));
    for (const [name, p] of Array.from(this.peers)) {
      const team = teams.get(String(name).trim().toLocaleLowerCase('tr'));
      if (team === undefined) {
        this.peers.delete(name);
        this.announce(p.channel, name);
        close(p.ws, CLOSE.notInRoom);
        continue;
      }
      p.team = team;
      if (!p.general) this.move(name, teamChannel(team));
    }
  }

  // Kanaldaki herkese güncel üye listesini gönder. Ayrılan biri varsa onun
  // adı da ayrıca bildirilir ki bağlantıyı hemen kapatsınlar.
  announce(channel, left = null) {
    const list = [];
    for (const [n, p] of this.peers) if (p.channel === channel) list.push(n);
    for (const p of this.peers.values()) {
      if (p.channel !== channel) continue;
      if (left) send(p.ws, { type: 'left', name: left });
      send(p.ws, { type: 'peers', channel, list });
    }
  }
}
