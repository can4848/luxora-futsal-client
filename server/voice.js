// Sesli iletişim işaretleşmesi — Cloudflare Workers üzerinde, oda başına bir
// Durable Object.
//
// NE TAŞIR — yalnızca "kim hangi kanalda" bilgisi ve eşlerin birbirine
// bağlanmak için ihtiyaç duyduğu teklif/yanıt/aday mesajları. SES BURADAN
// GEÇMEZ: ses oyuncudan oyuncuya doğrudan gider (WebRTC mesh). Bu yüzden
// sunucu maliyeti küçük kalır.
//
// KANALLAR — her oyuncu aynı anda tek bir kanaldadır:
//   red / blue  takımın özel kanalı
//   spec        izleyicilerin özel kanalı
//   general     odanın genel kanalı: takımı ne olursa olsun buraya geçen herkes
// Mesajlar yalnızca AYNI KANALDAKİLER arasında iletilir. Oyuncu bağlantıyı
// koparmadan kanal değiştirebilir (özel ↔ genel, ya da takım değişince).
//
// Kendi Worker'ına bağlamak için (README'de örnek var):
//   - `/voice?room=<oda>` isteğini `env.VOICE.idFromName(oda)` nesnesine yönlendir,
//   - wrangler ayarına `VOICE` adlı Durable Object bağlaması ve göçü ekle.

const MAX_PER_ROOM = 24;        // bir odada aynı anda en fazla kaç ses bağlantısı
const MAX_MSG = 16 * 1024;      // tek mesaj üst sınırı (SDP birkaç KB sürer)
const CHANNELS = new Set(['red', 'blue', 'spec', 'general']);

// Eski istemciler kanal değil takım gönderiyordu (1 kırmızı, 2 mavi).
const channelOf = (m) => (CHANNELS.has(m.channel) ? m.channel
  : m.team === 1 ? 'red' : m.team === 2 ? 'blue' : null);

export class VoiceRoom {
  constructor(state) {
    this.state = state;
    this.peers = new Map();     // name -> { ws, channel }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    this.accept(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  accept(ws) {
    ws.accept();
    let me = null;

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string' || ev.data.length > MAX_MSG) return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }

      // İlk mesaj kimlik olmalı.
      if (!me) {
        if (m.type !== 'hello') return ws.close(4000, 'hello first');
        const name = String(m.name || '').slice(0, 30);
        const channel = channelOf(m);
        if (!name || !channel) return ws.close(4001, 'bad hello');
        if (this.peers.size >= MAX_PER_ROOM && !this.peers.has(name)) return ws.close(4002, 'full');

        // Aynı isim ikinci kez bağlanırsa eskisi düşer (yeniden bağlanma).
        const old = this.peers.get(name);
        if (old) { try { old.ws.close(4003, 'replaced'); } catch {} }

        me = { name, channel };
        this.peers.set(name, { ws, channel });
        ws.send(JSON.stringify({ type: 'welcome', channel }));
        this.announce(channel);
        return;
      }

      // Kanal değişimi: bağlantı kopmadan özelden genele, ya da takım değişince.
      if (m.type === 'channel') {
        const next = channelOf(m);
        const mine = this.peers.get(me.name);
        if (!next || !mine || mine.ws !== ws || next === mine.channel) return;
        const prev = mine.channel;
        mine.channel = next;
        me.channel = next;
        ws.send(JSON.stringify({ type: 'welcome', channel: next }));
        this.announce(prev, me.name);
        this.announce(next);
        return;
      }

      // Bundan sonrası yalnızca eşler arası yönlendirme. Sunucu içeriğe bakmaz;
      // yalnızca hedef AYNI KANALDA mı diye bakar.
      if (!['offer', 'answer', 'ice'].includes(m.type)) return;
      const to = String(m.to || '').slice(0, 30);
      const target = this.peers.get(to);
      const mine = this.peers.get(me.name);
      if (!target || !mine || target.channel !== mine.channel) return;
      try { target.ws.send(JSON.stringify({ ...m, to: undefined, from: me.name })); } catch {}
    });

    // close ve error birlikte gelebiliyor; bildirim bir kez gitsin.
    let gone = false;
    const bye = () => {
      if (!me || gone) return;
      gone = true;
      const mine = this.peers.get(me.name);
      if (mine && mine.ws === ws) {
        this.peers.delete(me.name);
        this.announce(mine.channel, me.name);
      }
    };
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);
  }

  // Kanaldaki herkese güncel üye listesini gönder. Kimin kiminle bağlanacağına
  // istemci karar veriyor (teklifi adı küçük olan taraf verir). Ayrılan biri
  // varsa onun adı da ayrıca bildiriliyor ki bağlantıyı hemen kapatsınlar.
  announce(channel, left = null) {
    const list = [];
    for (const [n, p] of this.peers) if (p.channel === channel) list.push(n);
    const msg = JSON.stringify({ type: 'peers', channel, list });
    const bye = left ? JSON.stringify({ type: 'left', name: left }) : null;
    for (const p of this.peers.values()) {
      if (p.channel !== channel) continue;
      try {
        if (bye) p.ws.send(bye);
        p.ws.send(msg);
      } catch {}
    }
  }
}
