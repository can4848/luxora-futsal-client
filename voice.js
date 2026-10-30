// Luxora sesli iletişim motoru.
//
// Oyun görünümünün içinde (game-preload.js) çalışır. İki işi var:
//   1) Yerel ses: mikrofonu aç, cihazı seç, bas-konuş, konuşma algıla, seviye ölç.
//   2) Eşler arası ses: takım arkadaşlarıyla doğrudan bağlan (WebRTC mesh).
//
// NEDEN MESH — bir kanalda birkaç kişi var, herkes diğerlerine doğrudan
// bağlanıyor. Ortada ses sunucusu yok: ses hiçbir sunucudan geçmiyor.
// Yalnızca "kiminle bağlanacağım" bilgisi için küçük bir işaretleşme kanalı
// gerekiyor (aşağıdaki Signaling; sunucu tarafı `server/voice.js`).
//
// İşaretleşme sunucusuna ulaşılamazsa motor "sunucu yok" durumunda kalır:
// mikrofon, bas-konuş, seviye ölçer ve cihaz seçimi yine çalışır, yalnızca
// karşı tarafa ses gitmez.

const SIGNAL_URL = 'wss://luxorafutsal.com/voice';

// Bağlantı sunucuları. Gerçekleri siteden geliyor (kısa ömürlü TURN bilgileri);
// aşağıdaki yalnızca onlar gelmeden önceki yedek. TURN'süz kalındığında
// doğrudan bağlanamayan oyuncular panelde "bağlanamadı" olarak görünür.
const ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

const PTT_DEFAULT = 'KeyV';

// Konuşma algısı. Kısa sesler (klavye, nefes, tık) göstergede yanıp
// sönmesin, kelime aralarında da gösterge kapanmasın: seviye yumuşatılıyor,
// konuşma ~0,1 sn sürünce başlıyor, ~0,75 sn sessizlik olmadan bitmiyor.
class Vad {
  constructor(threshold) {
    this.t = threshold; this.avg = 0; this.on = false; this.hot = 0; this.quiet = 0;
  }

  // Durum değiştiyse true döner.
  push(level) {
    this.avg = this.avg * 0.8 + level * 0.2;
    if (this.avg > this.t) { this.hot += 1; this.quiet = 0; } else { this.quiet += 1; this.hot = 0; }
    if (!this.on && this.hot >= 6) { this.on = true; return true; }
    if (this.on && this.quiet >= 45) { this.on = false; return true; }
    return false;
  }
}

class VoiceEngine extends EventTarget {
  constructor() {
    super();
    this.state = 'off';          // off | no-server | connecting | live
    this.micOn = false;
    this.speaking = false;
    this.level = 0;              // 0–1, kendi mikrofon seviyen
    this.error = null;

    this.me = null;              // { name, team }
    this.room = null;            // { id, name }
    this.roster = [];            // odadaki oyuncular (canlı oda verisinden)
    this.peers = new Map();      // name -> { pc, stream, el, volume, muted, speaking, state }
    this.failed = new Map();     // name -> { tries, at } — bağlanamayanlar
    this.scope = 'team';         // team (özel) | general (genel)
    this.members = [];           // sunucuya göre kanalımdakiler (ben dahil)

    this.mode = 'ptt';           // ptt | open
    this.pttKey = PTT_DEFAULT;
    this.pttDown = false;
    this.inputGain = 0.8;
    this.outputGain = 0.7;
    this.deviceId = null;
    this.testOn = false;         // kendi sesini kendine dinletme (mikrofon testi)
    this.errorCode = null;       // denied | missing | busy | other — panel ne önereceğini buradan bilir
    this._starting = null;       // açılmakta olan mikrofon (aynı anda iki istek tek akış açsın)

    this.rawStream = null;       // cihazdan gelen ham ses
    this.stream = null;          // işlenmiş ses (eşlere giden)
    this.ctx = null;
    this.analyser = null;
    this.gainNode = null;
    this.testGain = null;
    this.track = null;
    this.signal = null;
    this.ice = null;             // siteden gelen bağlantı sunucuları (TURN dahil)
    this._raf = 0;
  }

  // Aktarıcı bilgileri kısa ömürlü; kabuk her oda bilgisiyle birlikte tazesini
  // gönderiyor. Kurulu bağlantılar etkilenmez, yenileri yeni listeyi kullanır.
  setIce(list) {
    if (Array.isArray(list) && list.length) this.ice = list;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // ── Mikrofon ───────────────────────────────────────────────────────────────

  // Otomatik açılma ile oyuncunun "Sesi aç" tıklaması aynı anda gelebilir;
  // ikisi de aynı açılışı bekler, iki ayrı mikrofon akışı açılmaz.
  enableMic() {
    if (this.micOn) return Promise.resolve(true);
    if (!this._starting) this._starting = this._startMic().finally(() => { this._starting = null; });
    return this._starting;
  }

  // Eskiden yalnızca izin isteği korunuyordu: ses yolunu kurarken çıkan bir
  // hata mikrofonu sessizce kapalı bırakıyor, oyuncuya hiçbir şey
  // söylenmiyordu. Artık her hata yakalanıp türüne göre anlatılıyor.
  async _startMic() {
    let raw = null;
    try {
      raw = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      this.rawStream = raw;
      this._buildGraph();
    } catch (e) {
      if (raw) raw.getTracks().forEach((t) => t.stop());
      this.rawStream = null;
      if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
      const n = e && e.name;
      this.errorCode = n === 'NotAllowedError' || n === 'SecurityError' ? 'denied'
        : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'missing'
        : n === 'NotReadableError' || n === 'AbortError' ? 'busy'
        : 'other';
      this.error = {
        denied: 'Mikrofon izni verilmedi.',
        missing: 'Mikrofon bulunamadı.',
        busy: 'Mikrofon açılamadı; başka bir uygulama kullanıyor olabilir.',
        other: 'Mikrofon açılamadı.',
      }[this.errorCode];
      // Seçili cihaz çıkarıldıysa (kulaklık söküldü gibi) bir dahaki sefere varsayılan denensin.
      if (this.errorCode === 'missing' && this.deviceId) this.deviceId = null;
      this.emit('change');
      return false;
    }

    this.micOn = true;
    this.error = null;
    this.errorCode = null;
    this._startMeter();
    this._applyGate();
    this.emit('change');
    this.emit('devices');

    // Mikrofon açılınca ağ tarafını da dene.
    this.connect();
    return true;
  }

  // Ses yolu:  cihaz → kazanç → [ölçer] → eşlere giden akış
  //                          └→ test kazancı → kulaklık (mikrofon testi)
  //
  // Araya kazanç düğümü konduğu için "giriş sesi" gerçekten çalışıyor; ham
  // akışı doğrudan göndermek olsaydı bu ayar hiçbir şeye yaramazdı.
  _buildGraph() {
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.rawStream);

    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this.inputGain * 2;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.75;

    this.testGain = this.ctx.createGain();
    this.testGain.gain.value = this.testOn ? 1 : 0;

    const dest = this.ctx.createMediaStreamDestination();

    src.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    this.gainNode.connect(dest);
    this.gainNode.connect(this.testGain);
    this.testGain.connect(this.ctx.destination);

    this.stream = dest.stream;
    this.track = this.stream.getAudioTracks()[0];
  }

  disableMic() {
    this.micOn = false;
    this.speaking = false;
    this.level = 0;
    this.testOn = false;
    if (this._raf) cancelAnimationFrame(this._raf), this._raf = 0;
    if (this.rawStream) this.rawStream.getTracks().forEach((t) => t.stop());
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.rawStream = null; this.stream = null; this.track = null;
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
    this.analyser = null; this.gainNode = null; this.testGain = null;
    this._disconnect();
    this.emit('change');
  }

  // Mikrofon testi: kendi sesini kendine dinletir. Bas-konuş kapısından ÖNCE
  // dinlendiği için tuşa basmadan da duyulur — amaç cihazın çalıştığını
  // doğrulamak. Hoparlörle açılırsa uğultu yapar, panel kulaklık uyarısı verir.
  toggleTest() {
    if (!this.micOn) return;
    this.testOn = !this.testOn;
    if (this.testGain) this.testGain.gain.value = this.testOn ? 1 : 0;
    this.emit('change');
  }

  async devices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      return list.filter((d) => d.kind === 'audioinput');
    } catch { return []; }
  }

  async setDevice(id) {
    this.deviceId = id || null;
    if (!this.micOn) return;
    this.disableMic();
    await this.enableMic();
  }

  setMode(m) { this.mode = m === 'open' ? 'open' : 'ptt'; this._applyGate(); this.emit('change'); }
  setPttKey(code) { this.pttKey = code || PTT_DEFAULT; this.emit('change'); }
  // Kaydırmaçlar bilerek olay yaymıyor: her oynatmada panel yeniden çizilseydi
  // sürükleme kopardı. Etiketi panel kendisi güncelliyor.
  setInputGain(v) {
    this.inputGain = v;
    if (this.gainNode) this.gainNode.gain.value = v * 2;
  }
  setOutputGain(v) {
    this.outputGain = v;
    this.peers.forEach((p) => { if (p.el) p.el.volume = p.muted ? 0 : v * (p.volume ?? 1); });
  }

  // Bas-konuş: tuş kalkınca mikrofon parçası kapatılır. Kapatmak susturmaktan
  // iyidir — ses paketleri hiç gönderilmez.
  onKey(e, down) {
    if (e.code !== this.pttKey || this.mode !== 'ptt') return false;
    if (this.pttDown === down) return true;
    this.pttDown = down;
    this._applyGate();
    this.emit('change');
    return true;
  }

  _applyGate() {
    if (!this.track) return;
    this.track.enabled = this.mode === 'open' ? true : this.pttDown;
  }

  get transmitting() {
    return this.micOn && (this.mode === 'open' ? this.speaking : this.pttDown);
  }

  _startMeter() {
    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    const vad = new Vad(0.1);
    const tick = () => {
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      this.level = Math.min(1, rms * 6);

      if (vad.push(this.level)) { this.speaking = vad.on; this.emit('change'); }

      this.emit('level');
      this._raf = requestAnimationFrame(tick);
    };
    tick();
  }

  // ── Kimlik, kadro ve kanal ─────────────────────────────────────────────────
  //
  // Her oyuncu aynı anda tek bir kanalda:
  //   özel  → takımdaysan takımın (red/blue), izleyicideysen izleyicilerin (spec)
  //   genel → odada genel sohbete geçen herkes (takım fark etmez)
  // Takımı oyunun canlı kadrosundan öğreniyoruz; kanaldaki üyeleri ise
  // sunucu söylüyor, çünkü genel kanala kimin geçtiğini kadro bilemez.

  get channel() {
    if (this.joined) return this.joined;   // sunucunun söylediği kanal
    if (this.scope === 'general') return 'general';
    const t = this.me ? this.me.team : 0;
    return t === 1 ? 'red' : t === 2 ? 'blue' : 'spec';
  }

  setRoom(room, roster) {
    const changed = !this.room || this.room.id !== room.id;
    this.room = room;
    this.roster = roster || [];

    const before = this.me ? this.channel : null;
    if (this.me) {
      const mine = this.roster.find((p) => p.name === this.me.name);
      this.me.team = mine ? mine.team : 0;
    }

    if (changed) this._disconnect();
    // Özel kanaldayken takım değişirse kanal da değişir (kırmızı → izleyici
    // gibi). Bağlantı kopmadan sunucuya bildirilir; eski kanaldakiler düşer.
    if (!changed && before && before !== this.channel) this._switchChannel();
    this.connect();
    this._syncPeers();
    this.emit('change');
  }

  // Özel ↔ genel geçişi.
  setScope(scope) {
    const next = scope === 'general' ? 'general' : 'team';
    if (next === this.scope) return;
    this.scope = next;
    this._switchChannel();
    this.emit('change');
  }

  _switchChannel() {
    this.members = [];
    this.peers.forEach((_, n) => this._dropPeer(n));
    this.failed.clear();
    this.joined = null;   // yeni kanalı sunucu 'welcome' ile söyleyecek
    if (this.signal && this.signal.ready) {
      this.signal.send({ type: 'channel', channel: this.scope === 'general' ? 'general' : 'team' });
    }
  }

  // Odadan çıkınca her şey bırakılır: bağlantılar, kadro, takım bilgisi.
  // Mikrofonu kapatmak katmanın işi (oyuncunun tercihine göre).
  leaveRoom() {
    this._disconnectQuiet();
    this.room = null;
    this.roster = [];
    this.members = [];
    this.failed.clear();
    if (this.me) this.me.team = 0;
    this.state = this.micOn ? 'connecting' : 'off';
    this.emit('change');
  }

  // Kimlik site girişinden geliyor (ana süreçteki oturum). Oyuncu kendi adını
  // seçmiyor: kimse başkasının kanalına giremesin.
  setIdentity(name) {
    if (this.me && this.me.name === name) return;
    const p = this.roster.find((x) => x.name === name);
    this.me = { name, team: p ? p.team : 0 };
    this._disconnect();
    this.connect();
    this.emit('change');
  }

  // Girdiğin hesap bu odada mı? Oyundaki adın hesabından farklıysa (ya da
  // henüz odaya girmediysen) kadroda görünmezsin.
  get inRoom() { return !!(this.me && this.roster.some((p) => p.name === this.me.name)); }

  // Kanalımda olan, kendim dışındaki oyuncular. Sunucunun listesi kadroyla
  // doğrulanıyor: odada olmayan biri listede görünemez, özel kanalda da
  // gerçekten aynı takımda (ya da izleyicide) olmayan biri sızamaz.
  teammates() {
    if (!this.me) return [];
    const team = (n) => { const p = this.roster.find((x) => x.name === n); return p ? p.team : null; };
    return this.members
      .filter((n) => n !== this.me.name)
      .map((n) => ({ name: n, team: team(n) }))
      .filter((m) => m.team !== null && (this.scope === 'general' || m.team === this.me.team));
  }

  // ── Ağ ─────────────────────────────────────────────────────────────────────

  connect() {
    if (!this.micOn || !this.me || !this.room) return;

    // Hesabın odadaki kadroda yoksa kime bağlanacağımızı bilemeyiz.
    if (!this.inRoom) {
      this._disconnectQuiet();
      this.state = 'no-name';
      this.emit('change');
      return;
    }

    if (this.signal && this.signal.ready) return this._syncPeers();
    if (this.signal) return;   // zaten bağlanıyor

    this.state = 'connecting';
    this.emit('change');

    // Kimliği sunucu biletle doğruluyor: istemci adını ya da takımını
    // söylemiyor, yalnız siteden aldığı tek kullanımlık bileti sunuyor. Her
    // bağlantı denemesi yeni bir bilet ister.
    const roomId = this.room.id;
    this.signal = new Signaling(`${this.signalUrl || SIGNAL_URL}?room=${encodeURIComponent(roomId)}`, {
      hello: async () => {
        const t = this.getToken ? await this.getToken(roomId) : null;
        if (!t || !t.token) return { error: (t && t.error) || 'auth' };
        return { token: t.token, channel: this.scope === 'general' ? 'general' : 'team' };
      },
      onReady: (w) => {
        // Kanalı sunucu belirliyor (kadrodaki gerçek takımdan); ona uy.
        this.joined = w.channel || null;
        this.state = 'live'; this.emit('change'); this._syncPeers();
      },
      onDown: (reason) => {
        this.state = reason === 'missing' ? 'no-server'
          : reason === 'not-in-room' ? 'no-name'
          : reason === 'auth' ? 'no-auth'
          : reason === 'update' ? 'update'
          : reason === 'replaced' ? 'replaced'
          : 'connecting';
        this.joined = null;
        this.members = [];
        this.peers.forEach((_, n) => this._dropPeer(n));
        this.emit('change');
      },
      onMessage: (m) => this._onSignal(m),
    });
    this.signal.open();
  }

  _disconnect() {
    this._disconnectQuiet();
    this.state = this.micOn ? 'connecting' : 'off';
    this.emit('change');
  }

  _disconnectQuiet() {
    if (this.signal) { this.signal.close(); this.signal = null; }
    this.members = [];
    this.peers.forEach((_, n) => this._dropPeer(n));
  }

  // Bağlantıları kanalla hizala: ayrılanı düşür, geleni kur.
  _syncPeers() {
    if (this.state !== 'live') return;
    const want = new Set(this.teammates().map((p) => p.name));
    this.peers.forEach((_, name) => { if (!want.has(name)) this._dropPeer(name); });
    // Kanaldan çıkanın başarısızlık sayacı da sıfırlansın: geri gelince
    // yeniden denensin.
    this.failed.forEach((_, name) => { if (!want.has(name)) this.failed.delete(name); });
    // Çifte teklifi önlemek için teklifi her zaman adı küçük olan taraf verir.
    want.forEach((name) => {
      if (this.peers.has(name)) return;
      if (!this._mayOffer(name)) return;
      if (this.me.name < name) this._offer(name);
    });
    this.emit('change');
  }

  _newPeer(name) {
    const pc = new RTCPeerConnection({ iceServers: this.ice || ICE });
    const p = { pc, stream: null, el: null, volume: 1, muted: false, speaking: false, state: 'bağlanıyor' };
    this.peers.set(name, p);

    if (this.stream) this.stream.getAudioTracks().forEach((t) => pc.addTrack(t, this.stream));

    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal.send({ to: name, type: 'ice', ice: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      p.stream = e.streams[0];
      const el = new Audio();
      el.srcObject = p.stream;
      el.autoplay = true;
      el.volume = p.muted ? 0 : this.outputGain * p.volume;
      el.play().catch(() => {});
      p.el = el;
      this._watchPeer(name, p);
      this.emit('change');
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      p.state = s === 'connected' ? 'bağlı'
        : s === 'failed' ? 'bağlanamadı'
        : s === 'disconnected' ? 'koptu' : 'bağlanıyor';
      if (s === 'connected') this.failed.delete(name);
      if (s === 'failed') return this._peerFailed(name);
      this.emit('change');
    };
    return p;
  }

  // Aktarıcı (TURN) olmadığı sürece oyuncuların bir bölümü birbirine doğrudan
  // bağlanamaz. Eskiden bağlantı düşünce hemen yenisi kuruluyordu: aynı kişiye
  // saniyede bir teklif gidip duruyordu, sonsuz döngü. Artık üç denemeden
  // sonra vazgeçiliyor ve panelde sebebi yazıyor.
  _peerFailed(name) {
    const f = this.failed.get(name) || { tries: 0, at: 0 };
    f.tries += 1;
    f.at = Date.now();
    this.failed.set(name, f);
    this._dropPeer(name);
    if (f.tries < 3) setTimeout(() => this._syncPeers(), 2000 * f.tries);
    this.emit('change');
  }

  // Bu kişiye şimdi teklif verilebilir mi? (vazgeçilmediyse ve bekleme bittiyse)
  _mayOffer(name) {
    const f = this.failed.get(name);
    if (!f) return true;
    if (f.tries >= 3) return false;
    return Date.now() - f.at >= 2000 * f.tries;
  }

  // Bir takım arkadaşıyla hiç bağlanılamadı mı?
  gaveUpOn(name) {
    const f = this.failed.get(name);
    return !!(f && f.tries >= 3);
  }

  // Karşı tarafın konuşup konuşmadığını kendi sesinden ölçüyoruz; ayrıca veri
  // göndermeye gerek kalmıyor.
  _watchPeer(name, p) {
    try {
      if (!this.ctx) return;
      const src = this.ctx.createMediaStreamSource(p.stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 256; an.smoothingTimeConstant = 0.7;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      // Karşıdan gelen ses sıkıştırılmış olarak gelir, biraz daha alçak: eşik düşük.
      const vad = new Vad(0.08);
      const tick = () => {
        if (!this.peers.has(name)) return;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const lvl = Math.min(1, Math.sqrt(sum / buf.length) * 6);
        if (vad.push(lvl)) { p.speaking = vad.on; this.emit('peers'); }
        requestAnimationFrame(tick);
      };
      tick();
    } catch {}
  }

  async _offer(name) {
    const p = this._newPeer(name);
    const offer = await p.pc.createOffer({ offerToReceiveAudio: true });
    await p.pc.setLocalDescription(offer);
    this.signal.send({ to: name, type: 'offer', sdp: offer.sdp });
  }

  async _onSignal(m) {
    if (m.type === 'peers') {
      // Başka bir kanalın listesi geç gelirse (kanal değiştirirken) yok say.
      if (m.channel && m.channel !== this.channel) return;
      this.members = Array.isArray(m.list) ? m.list.map(String) : [];
      return this._syncPeers();
    }
    if (m.type === 'left') {
      this.members = this.members.filter((n) => n !== m.name);
      return this._dropPeer(m.name);
    }
    if (!m.from) return;
    // Kanalımda olmayan birinden gelen teklif (kanal değiştirirken geç kalmış
    // olabilir) bağlantı açmasın.
    if (m.type === 'offer' && !this.teammates().some((t) => t.name === m.from)) return;

    // Bozuk ya da zamansız bir mesaj (yarım SDP, kapanmış bağlantıya gelen
    // yanıt) motoru düşürmesin: o eş bağlanamadı sayılır, gerisi çalışır.
    try {
      if (m.type === 'offer') {
        const p = this.peers.get(m.from) || this._newPeer(m.from);
        await p.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        const ans = await p.pc.createAnswer();
        await p.pc.setLocalDescription(ans);
        if (this.signal) this.signal.send({ to: m.from, type: 'answer', sdp: ans.sdp });
      } else if (m.type === 'answer') {
        const p = this.peers.get(m.from);
        if (p) await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      } else if (m.type === 'ice') {
        const p = this.peers.get(m.from);
        if (p && m.ice) await p.pc.addIceCandidate(m.ice).catch(() => {});
      }
    } catch {
      if (this.peers.has(m.from)) this._peerFailed(m.from);
    }
  }

  _dropPeer(name) {
    const p = this.peers.get(name);
    if (!p) return;
    try { p.pc.close(); } catch {}
    if (p.el) { p.el.pause(); p.el.srcObject = null; }
    this.peers.delete(name);
    this.emit('change');
  }

  setPeerVolume(name, v) {
    const p = this.peers.get(name);
    if (!p) return;
    p.volume = v;
    if (p.el) p.el.volume = p.muted ? 0 : this.outputGain * v;
  }

  togglePeerMute(name) {
    const p = this.peers.get(name);
    if (!p) return;
    p.muted = !p.muted;
    if (p.el) p.el.volume = p.muted ? 0 : this.outputGain * p.volume;
    this.emit('peers');
  }
}

// ── İşaretleşme kanalı ───────────────────────────────────────────────────────
// Yalnızca "kiminle bağlanacağım" trafiği taşır; ses buradan geçmez.
// Uç yayında değilken sessizce "missing" durumuna düşer, panel bunu yazar.

// Sunucunun kapanış kodları (server/voice.js ile aynı).
const CLOSE_REASON = {
  4003: 'replaced',      // aynı hesap başka yerden bağlandı
  4004: 'not-in-room',   // hesap odanın kadrosunda yok
  4005: 'auth',          // bilet geçersiz / süresi doldu
  4010: 'update',        // istemci eski
};

class Signaling {
  constructor(url, h) {
    this.url = url; this.h = h;
    this.ws = null; this.ready = false; this.tries = 0; this.dead = false;
    this.opened = false;   // soket bir kez bile açıldı mı
  }

  open() {
    if (this.dead) return;
    let ws;
    try { ws = new WebSocket(this.url); } catch { return this._down('missing'); }
    this.ws = ws;
    let reason = null;

    ws.onopen = async () => {
      this.opened = true;
      const hello = await this.h.hello();
      if (this.ws !== ws || this.dead) return;
      if (hello.error) { reason = 'auth'; try { ws.close(); } catch {} return; }
      ws.send(JSON.stringify({ type: 'hello', ...hello }));
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'welcome') { this.ready = true; this.tries = 0; this.h.onReady(m); return; }
      this.h.onMessage(m);
    };
    ws.onclose = (ev) => {
      this.ready = false;
      reason = CLOSE_REASON[ev && ev.code] || reason;
      // "Sunucu yok" yalnızca soket HİÇ açılamadıysa doğrudur. Açılıp sonra
      // kapandıysa sunucu ayakta, sorun başka yerde.
      this._down(reason || (this.opened ? 'retry' : 'missing'));
      if (this.dead) return;
      // Eski istemci ya da başka cihazdan devralma: tekrar denemek boşuna,
      // iki cihaz birbirini sırayla düşürürdü.
      if (reason === 'update' || reason === 'replaced') return;
      this.tries += 1;
      // Odada değilse ya da bilet alınamadıysa daha seyrek dene.
      const slow = reason === 'not-in-room' || reason === 'auth';
      setTimeout(() => this.open(), Math.min((slow ? 5000 : 2000) * this.tries, 30000));
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  _down(reason) { if (!this.dead) this.h.onDown(reason); }

  send(m) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  // Kapatırken dinleyiciler de sökülüyor: kendi kapattığımız soketin geç gelen
  // onclose'u "bağlantı koptu" sanılıp durumu yanlış yazıyordu.
  close() {
    this.dead = true; this.ready = false;
    if (this.ws) {
      this.ws.onopen = this.ws.onclose = this.ws.onerror = this.ws.onmessage = null;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}

module.exports = { VoiceEngine, PTT_DEFAULT };
