# Luxora Futsal — Masaüstü İstemci

[Luxora Futsal](https://luxorafutsal.com) odalarında **sesli sohbet** sağlayan
Haxball istemcisi. Windows, macOS ve Linux'ta çalışır.

Uygulama Haxball'un kendi oda listesini açar. Bir Luxora odasına girdiğinde
sesli sohbet kendiliğinden açılır; başka bir odaya girdiğinde sesli sohbetin
orada çalışmadığını söyler ve oynamaya devam edersin.

## Özellikler

- **Özel kanal:** takımdaysan takım arkadaşlarınla, izleyicideysen izleyicilerle konuşursun.
- **Genel kanal:** odada genel sohbete geçen herkes, takım fark etmeksizin birbirini duyar.
- **Bas-konuş** (varsayılan `V`, değiştirilebilir) ya da açık mikrofon.
- **Kim konuşuyor:** konuşanların adı ekranın sol üstünde görünür.
- Kişi başına ses seviyesi ve susturma, mikrofon seçimi, giriş/çıkış sesi.
- **Mikrofon testi:** kendi sesini dinleyebilir, seviye çubuğuyla duyulup duyulmadığını görebilirsin.
- Ses paneli oyunun üstünde yüzer, sahadan yer çalmaz; sürüklenip köşeye yapıştırılabilir.
- Tam ekran (`F11`).
- Giriş yaptıysan Haxball'un ad ekranı hesabının adıyla kendiliğinden geçilir, doğrudan oda listesi açılır.
- **Otomatik güncelleme:** yeni sürüm arka planda iner; üst çubukta *Yeniden başlat* çıkar, basmazsan uygulamayı kapatırken kurulur.

## İndirme

Hazır paketler [Releases](../../releases) sayfasında.

| Platform | Dosya |
|---|---|
| Windows | `LuxoraFutsal-Kurulum-<sürüm>.exe` — tek tık kurulur, kendini günceller |
| Windows (kurulumsuz) | `LuxoraFutsal-<sürüm>-win.zip` — çıkar, `Luxora Futsal.exe`'yi çalıştır |
| macOS (Apple çipli) | `LuxoraFutsal-<sürüm>-mac-arm64.dmg` |
| macOS (Intel) | `LuxoraFutsal-<sürüm>-mac-x64.dmg` |
| Linux | `LuxoraFutsal-<sürüm>-linux-x86_64.AppImage` ya da `.tar.gz` |

Kendini güncelleyen sürümler: Windows kurulumu ve Linux AppImage. Mac ile
zip/tar.gz kopyaları yeni sürüm çıkınca üst çubukta *İndir* düğmesi gösterir
(imzasız Mac uygulamasını Apple kendiliğinden güncelletmiyor).

### İlk açılış

Uygulama imza sertifikası olmadan dağıtılıyor, bu yüzden işletim sistemi ilk
açılışta uyarı verir:

- **Windows:** "Windows bilgisayarınızı korudu" → *Ek bilgi* → *Yine de çalıştır*.
- **macOS:** uygulamaya **sağ tıklayıp *Aç*** de (çift tıklama ilk seferde engellenir).
  "Uygulama hasarlı" mesajı çıkarsa Terminal'de:
  ```bash
  xattr -cr "/Applications/Luxora Futsal.app"
  ```
- **Linux (AppImage):** `chmod +x LuxoraFutsal-*.AppImage` ile çalıştırılabilir yap.
  Ubuntu 24.04 ve sonrasında açılmazsa `--no-sandbox` ile başlat.

Sesli sohbet için Luxora hesabınla giriş yapman gerekir; hesabın yoksa bir
Luxora odasında sohbete `!kayit şifren` yaz. Uygulamaya girdiğin ad, oyundaki
adınla aynı olmalı.

## Nasıl çalışıyor

```
Haxball sayfası (haxball.com/play)
 └─ oyun çerçevesi ── odanın adı ──▶ katman: "bu bir Luxora odası mı?"
                                       │
           luxorafutsal.com/live ──────┤ canlı oda listesi + kim hangi takımda
                                       │
           luxorafutsal.com/voice ─────┤ işaretleşme: kim kiminle bağlanacak
                                       ▼
                           oyuncu ⇄ oyuncu  (ses, WebRTC — sunucudan geçmez)
```

- **Oda algılama:** Haxball listeden odaya girildiğinde adres çubuğunu
  değiştirmiyor. Ama oyun çerçevesi aynı kaynakta ve odanın adını
  `h1[data-hook="room-name"]` öğesine yazıyor; katman bu adı okuyup canlı Luxora
  oda listesiyle eşleştiriyor.
- **Ses:** oyuncular birbirine doğrudan bağlanır (WebRTC mesh). Sunucu yalnızca
  bağlantı kurulması için gereken kısa mesajları iletir; ses hiçbir sunucudan
  geçmez ve kaydedilmez.
- **Kanallar:** sunucu mesajları yalnızca aynı kanaldakiler arasında iletir.
  İstemci ayrıca sunucunun verdiği listeyi oyunun kadrosuyla doğrular: özel
  kanalına başka takımdan biri giremez.
- **Klavye:** oyun tuşları oyun çerçevesinde dinleniyor; bas-konuş da oraya
  takılı. Haxball'un kendi tuşlarına (Tab/Enter sohbet, Esc menü) dokunulmaz.
  Sohbete yazarken bas-konuş tetiklenmez.

### Dosyalar

| Dosya | İşi |
|---|---|
| `main.js` | Ana süreç: pencere, oyun görünümü, giriş, tam ekran, platform farkları |
| `preload.js` | Arayüz ile ana süreç arasındaki köprü |
| `renderer/` | Açılış ve üst çubuk |
| `game-preload.js` | Oyun sayfasına eklenen katman: oda algılama, ses paneli, giriş formu |
| `voice.js` | Ses motoru: mikrofon, bas-konuş, kanallar, eşler arası bağlantı |
| `server/voice.js` | İşaretleşme sunucusu (Cloudflare Durable Object) |

## Gizlilik

- **Giriş:** kullanıcı adın ve şifren yalnızca `luxorafutsal.com`'a gönderilir.
  Şifre bilgisayarına kaydedilmez; geriye yalnızca oturum çerezi kalır.
- **Ses:** doğrudan diğer oyunculara gider, hiçbir sunucuda tutulmaz ya da
  kaydedilmez. Mikrofon yalnızca bir Luxora odasındayken açılır, odadan
  çıkınca kapanır.
- **Haxball:** oyunun kendisine ve trafiğine dokunulmaz; uygulama yalnızca
  sayfanın üstüne kendi katmanını ekler.

## Kaynaktan derleme

Node.js 20+ gerekir.

```bash
npm install
npm start            # geliştirme
npm run dist         # Windows
npm run dist:linux   # Linux
npm run dist:mac     # macOS (yalnızca Mac'te)
```

Paketler `dist/` klasörüne çıkar. GitHub Actions üç platformu da derler;
`v` ile başlayan bir etiket (`v0.1.0` gibi) gönderildiğinde paketler otomatik
olarak bir sürüme eklenir.

> Linux paketini Windows'ta derlersen çalıştırma izinleri kaybolur (Windows
> dosya sistemi bu bilgiyi tutmuyor). Linux paketlerini Linux'ta ya da GitHub
> Actions'ta derle.

### İşaretleşme sunucusunu kendi Worker'ına bağlamak

```js
import { VoiceRoom } from './voice.js';
export { VoiceRoom };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/voice') {
      const room = (url.searchParams.get('room') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
      if (!room) return new Response('room required', { status: 400 });
      return env.VOICE.get(env.VOICE.idFromName(room)).fetch(request);
    }
    return new Response('not found', { status: 404 });
  },
};
```

`wrangler.jsonc`:

```jsonc
"durable_objects": { "bindings": [
  { "name": "VOICE", "class_name": "VoiceRoom" },
  { "name": "HUB", "class_name": "Hub" }
] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["VoiceRoom"] }]
```

**Kimlik doğrulaması.** Ses sunucusu istemciye hiçbir konuda güvenmez. Bağlanan
istemci, sitenin giriş yapmış oyuncuya verdiği **tek kullanımlık, 60 saniyelik
bir ses biletiyle** gelir (`GET /voice/token?room=<oda>`). Sunucu adı ve takımı
bu biletten ve odanın canlı kadrosundan öğrenir; özel kanal her zaman kadrodaki
gerçek takımdan türetilir. Bunun için `HUB` bağlamasının üç iç yolu cevaplaması
gerekir (dışarıya açık olmamalı):

| Yol (POST) | Gövde | Cevap |
|---|---|---|
| `/__voice/verify` | `{ token, room }` | `{ ok, nick, team }` — bilet tek kullanımlık, oda eşleşmeli, hesap kadroda olmalı |
| `/__voice/team` | `{ room, nick }` | `{ ok, team }` |
| `/__voice/roster` | `{ room }` | `{ ok, players: [{ key, team }] }` — `key` küçük harfli ad |

`team`: 0 izleyici, 1 kırmızı, 2 mavi.

## Lisans

Kod [MIT](LICENSE) lisansıyla açıktır. **Luxora Futsal adı, logosu ve açılış
videosu bu lisansın kapsamında değildir;** kendi projende kullanacaksan
bunları değiştir.

Haxball, Basro'nun bir oyunudur; bu proje Haxball ile resmî bir bağ taşımaz.
