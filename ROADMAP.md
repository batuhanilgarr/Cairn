# Cairn Yol Haritası

## Değişmez ilkeler

1. **Postman'den daha iyi olmak zorundayız:** tasarımda, özellikte VE performansta. Hepsinde aynı seviyede kalırsak bu ürünü yapmanın anlamı yok.
2. **Arayüz hatası olmamalı.** CSS tabanlı düzen hataları (taşma, kırılan çipler, örtülen düğmeler, çöken kenar çubuğu) göz kararıyla değil `npm run test:ui` ile yakalanır. Bu paket CI'da her push'ta çalışır. Yeni bir arayüz hatası bulunursa önce onu yakalayan bir test eklenir, sonra düzeltilir.
3. **Performans iddiası ölçümle yapılır.** `npm run bench:ui` tekrarlanabilir bir kıyas verir; sayılar donanımla birlikte raporlanır.
4. **Eksikler tahminle değil kullanıcı kanıtıyla seçilir** (aşağıdaki araştırma).

## Araştırma (2026-10-14): Postman'in gerçek eksikleri

Kaynaklar GitHub issue listeleri, Postman topluluk forumu, HN ve rakip belgeleri. **Sınırlar:** Reddit sonuç vermedi, forum oyları alınamadı, GitHub'daki sayılar "reaksiyon mu yorum mu" ayırt edilemeden okundu (bu yüzden "n gösterildi" diye anılır) ve rakip bloglarının çoğu kendi ürününü öven kaynaklardır. Kesin talep ölçüsü olarak değil, yön gösterici olarak oku.

**En sık ve en yoğun şikâyetler** (Postman):
1. Zorunlu hesap/bulut ve çevrimdışı çalışmanın kaybı (Scratch Pad kaldırıldı). *Cairn: karşılıyor (yerel öncelikli, hesap yok).*
2. Sırların bulut senkronuyla sızması ve kurumsal yasaklar (Truffle Security: ~4.000 canlı kimlik bilgisi). *Cairn: sırlar git-ignored dosyada, Postman import'u kimlik bilgilerini dosyalardan çıkarıyor. **Eksik:** OS anahtarlığı, paylaşım/dışa aktarım öncesi sır tarayıcı.*
3. v12 YAML formatı (Mart 2026): eski koleksiyonlar içe aktarılamadı, Git senkronu bozuldu, **şema yayınlanmadı**. *Cairn: **eksik:** biçimin yayınlanmış, sürümlü şeması; kuru-çalıştırma (dry-run) import önizlemesi.*
4. Performans: RAM, açılış, büyük koleksiyonlarda takılma, yanıt gösterimi 50 MB'ta kesiliyor (100 MB üstü çökme riski). *Cairn: aşağıdaki ölçümlere bak.*
5. Arayüz şişkinliği, 6. araya giren yapay zekâ (kapatılamayan modal; Nisan 2026'da geri çekildi), 7. fiyat/plan değişiklikleri (Free tek kullanıcı oldu), 8. Git dostu dosya tabanlı koleksiyon isteği, 9. script'lerin uygulama ile CLI'da farklı davranması, 10. içe/dışa aktarım doğruluğu.

**Talep edilen ama karşılanmayan özellikler** (talep × efor sırasıyla):
1. ~~Aynı isteği birden çok koleksiyonda yeniden kullanma (Postman #1535)~~ — **Yapıldı (v1):** bir istek dosyası yalnızca `use: ../shared/login.req.yaml` içerebilir. İçerik paylaşılan dosyadan gelir, düzenleme paylaşılan dosyaya yazılır (her yerde değişir); başlıklar/auth/değişkenler bağlantının durduğu klasörden gelir. Arayüz: klasör menüsünde "Link a request…", ağaçta ⛓ işareti, istekte uyarı şeridi, "Make a separate copy". Runner, mock sunucu ve CLI bağlantıları izliyor. **Sınırlar:** bağlantıda geçersiz kılma (override) yok; yol göreli/mutlak, `@/` kısayolu ve farklı repo'lar arası paylaşım henüz yok; bir bağlantı başka bir bağlantıyı gösteremez; paylaşılan dosyayı silmek bağlantıları kırar (hata net söyleniyor).
2. ~~Yanıtlarda jq/JSONPath filtresi (Bruno #7423, Insomnia #777)~~ — **Yapıldı** (yanıt gövdesinin üstünde filtre satırı; `$` ile başlarsa JSONPath, aksi halde jq alt kümesi; `src/lib/filter.ts`, 9 birim testi + UI testi). Sınır: tam jq değil, bir alt küme. **8 MB üstü (Rust'ta tutulan) yanıtlarda da çalışır:** aynı dil `src-tauri/src/filter.rs`'de (TypeScript motorunun portu, gövde sayfaya gönderilmeden filtrelenir; gezinen filtreler belgeyi kopyalamaz); iki motor `tests/fixtures/filter-cases.json` içindeki 342 ortak vektörde birebir aynı cevabı verir (hata mesajları dahil; `node scripts/gen-filter-cases.mjs`). Ölçüm (Apple M1, release, 50 MB / 467 bin satır): ilk filtre (JSON ayrıştırma dahil) 0,43 sn, tüm satırlarda `select` 0,35 sn, JSONPath 0,24 sn. Sınırlar: büyük gövdede 25 milyon ara değer ve 25 sn üst sınırı, sonuç metni 2 MB'ta kesilir (kaç sonuç olduğu yine söylenir); `test()` Rust `regex` söz dizimini kullanır (JS'in lookahead'i yok); `length`/dilimler Unicode karakter sayar, JS UTF-16 birimi.
3. ~~Birden çok .env dosyası, iç içe ve çoklu ortam seçimi~~ — **Yapıldı:** ortam dosyasında `extends: Ad` (zincirleme, döngüye dayanıklı, devre dışı değişken üst değeri gizlemez), arayüzde "Inherits from", ".env" dosyasından ortam oluşturma (`Import .env`, gizli görünen anahtarlar otomatik secret), CLI'da `--env base,staging` katmanlama. Sınır: arayüzde aynı anda birden çok ortam seçilemiyor (katmanlama yalnız `extends` ile; CLI listesi ayrıca var).
4. Sekme geliştirmeleri (Yaak 66 oy, Insomnia #1003, Postman #9180) — **Büyük ölçüde yapıldı:** ağaçta tek tıkla önizleme sekmesi (italik; düzenleyince, gönderince, çift tıklayınca kalıcı olur), sürükleyerek sıralama, sağ tık / menü tuşu ile sekme menüsü (Close others, Close to the right, Duplicate, Move), ⇧⌘T ile kapatılan sekmeyi geri açma. **Yan yana (bölünmüş) görünüm de yapıldı:** ⌘\\ (ya da sekme menüsünde "Open to the right") iki sekmeyi yan yana açar; her bölmenin kendi URL çubuğu, isteği ve yanıtı vardır, tıklanan bölme odak alır (üstünde vurgu çizgisi, sekme şeridinde işaret). Bölünmüşken açılan/seçilen sekme odaklı bölmenin yerine geçer; bölmedeki sekme kapanınca bölme biter. **Sınırlar:** istek/yanıt alt sekmesi seçimi (Params/Headers…, Raw, Wrap) iki bölme arasında ortaktır; odaksız bölme miras alınan başlık/auth ve OAuth token bilgisini odak alana kadar göstermez; bölme oturumlar arasında saklanmaz; `.main` genişliği 880 px ve altında (kenar çubuğu açıkken pencere ≈ 1180 px) yalnızca odaktaki bölme görünür. Farklı koleksiyonlardan sekmeler zaten kalıcı ama koleksiyon değişince nasıl davrandığı denenmedi.
5. Sır tarayıcı + kasa entegrasyonu (Postman #13605, Hoppscotch #5643) — **Sır tarayıcı yapıldı:** `cairn scan` (CI/pre-commit; bilinen token biçimleri, hassas anahtar adlarındaki düz değerler, URL'deki şifre, `.cairn/` git-ignore denetimi; çıktıda yalnız maskeli önizleme; çıkış kodu 1) ve arayüzde "Scan for secrets…" ("Move to secret": değeri `{{değişken}}` ile değiştirir, değeri gizli ortam değişkenine taşır; ortam dosyalarındaki değişkeni "gizli" işaretler). **macOS Anahtarlığı da yapıldı:** Ayarlar > Secrets > "Keep secret values in" (dosya ya da Anahtarlık). Anahtarlıkta tutulan değerin yerine `.cairn/secrets.yaml`'da `keychain:` işaretçisi yazılır; değer Security framework ile (komut satırına geçmeden) Anahtarlık'ta durur. Ayar değişince açık koleksiyonun sırları taşınır, geri taşınınca Anahtarlık kayıtları silinir, ortam silinince sırları da unutulur, Anahtarlık reddederse değer kaybolmaz dosyada kalır ve kullanıcı uyarılır. CLI aynı Mac'te `security` ile okur, okuyamazsa açıkça söyler (`--var` ile verilir). **Genel değişkenler de Anahtarlık'a taşınır:** Ayarlar > Variables'ta 🔒 ile gizli işaretlenen genel değişkenin değeri, Anahtarlık seçiliyken `localStorage`'da değil Anahtarlık'ta durur (orada yalnızca `keychain:` işaretçisi); açılışta Anahtarlık'tan okunur, yazılamazsa değer kaybolmaz ayarlarda kalır ve uyarı çıkar, Postman'dan taşınan kimlik bilgileri artık gizli genel değişken olarak gelir. **Kalan:** Windows/Linux anahtarlıkları, HashiCorp/1Password; koleksiyon klasörü başka yere taşınırsa Anahtarlık hesabı klasör yoluna bağlı olduğundan değerler dosya modunda geri verilmedikçe bulunamaz; Git geçmişinde önceden sızmış değerleri tarama (yalnız mevcut dosyalar taranıyor); entropi tabanlı genel tespit (kasıtlı olarak yok, yanlış alarmı artırır).
6. OpenAPI'ye dışa aktarma — **Yapıldı** (OpenAPI 3.0.3: istek→operasyon, klasör→tag, kayıtlı örnekler→yanıtlar, auth→securitySchemes, miras alınan başlık/auth uygulanır, `{{baseUrl}}`→server; kimlik bilgileri asla yazılmaz, örneklerdeki hassas alanlar `<redacted>` olur; arayüzde "Export OpenAPI…", CLI'da `cairn export openapi`; kendi içe aktarıcımızla gidiş-dönüş testli; Redocly 2.63.0 ve swagger-cli ile geçerli çıkıyor, CI'da `npm run test:openapi` ile korunuyor). **HAR içe aktarma da yapıldı** (tarayıcı kaydı → istekler: yalnız API çağrıları varsayılan, `{{baseUrl}}`, tekrarlar tek, GraphQL/form/multipart tanınır, kaydedilen yanıt örnek olur; Authorization, API anahtarı, çerez, şifre ve token'lar dosyalara hiç yazılmaz, gizli ortam değişkenine gider ve Cairn'in kendi sır tarayıcısı sonuçta sıfır bulgu verir — testli). **Panodan OpenAPI içe aktarma da yapıldı** ("OpenAPI / Swagger from clipboard": yapıştırılan JSON/YAML'ı ya da spec bağlantısını içe aktarmadan önce önizler). **WSDL/SOAP içe aktarma da yapıldı:** WSDL 1.1'deki her SOAP işlemi bir POST olur (SOAP 1.1 ve 1.2 portları ayrı klasörlerde; doğru Content-Type ve SOAPAction; adres `{{baseUrl}}` olur). Gövde XSD şemasından üretilen düzenlenmeye hazır bir zarftır: document/literal ve rpc/literal, enumeration'ın ilk değeri, liste ve tekrar (`minOccurs`/`maxOccurs` yorumlarıyla), `extension` ile kalıtım, öznitelikler, SOAP başlıkları (`soap:header`), özyinelemeli tiplerde durma; `xsd:import`/`wsdl:import` URL ya da dosyanın yanından çekilir, çekilemeyen notlarda söylenir. Menüden (URL/dosya), panodan (önizlemeli) ve komut paletinden çalışır; kendi küçük, bağımlılıksız, isim alanlı XML okuyucumuz var (`src/lib/xml.ts`). **Sınırlar:** WSDL 2.0 desteklenmez (açık hata verir), `rpc/encoded` yalnızca yaklaşık bir zarf üretir, `xsd:group` ve `xsd:any` yorum satırı olur, WS-Security/MTOM yok, düz HTTP binding'leri atlanır, gerçek bir SOAP servisine karşı denenmedi (yalnızca bu depodaki örnek WSDL'lerle). **`cairn import har` (CLI) de yapıldı:** `cairn import har kayıt.har [koleksiyon] [--all] [--name] [--dry-run] [--format json]`; uygulamadaki aynı motor, çıktısında hiçbir kimlik bilgisi yok, sonuç `cairn scan` ve `cairn validate`'ten temiz geçer (testli). **Kalan:** gRPC/WS/SSE/MCP istekleri OpenAPI'de ifade edilemediği için atlanıyor (notlarda söylenir); şema çıkarımı yalnız örnek değerlerden (zorunlu alan/enum bilgisi yok).
7. Socket.IO, ardından MQTT (Bruno #5887, #6511) — **M**
8. OAuth2 cilası: otomatik yenileme/sıfırlama, `client_assertion`, özel `redirect_uri` — **S**
9. Uygulama içi Git arayüzü + dosya izleme (Hoppscotch #870, Bruno #5498) — **M**
10. Koleksiyondan statik dokümantasyon dışa aktarımı, ekran okuyucu (erişilebilirlik) geçişi — **M**
Ek: klavye odaklı kullanım/Vim modu, ağ koşulu taklidi (gecikme/kayıp), seçili isteklerle runner arayüzü.

**Rakip haritasının boş bıraktığı alan:** hızlı + yerel + hesapsız + eksiksiz protokol/mock/script/CLI aynı üründe; **devasa yanıtları akıtarak/sanallaştırarak gösteren bir istemci yok**; yayınlanmış, tekrarlanabilir performans ölçümü yok; lisans/fiyat modeli birçok rakipte karışık.

## Ölçülen başlangıç noktamız (npm run bench:ui, stub IPC, Chrome)

| Senaryo | Sonuç | Hüküm |
|---|---|---|
| 10.000 istekli koleksiyon | ilk satırlara **10,2 sn**, 10.020 DOM satırı, 140.774 DOM düğümü, ~180–200 MB | **Kötü:** liste sanallaştırılmıyor |
| 5 MB yanıt | 0,3 sn, 0,27 sn donma | Kabul edilebilir |
| 50 MB yanıt | 2,5 sn, **2,5 sn donma**, **913 MB bellek** | **Kötü:** biçimlendirme ve gösterim ana iş parçacığında, çok kopya |

Not: stub IPC dosya/ağ G/Ç'sini içermez, gerçek uygulamada süreler uzar. Postman'in 50 MB gösterim sınırını geçmek ve 100 MB+ yanıtları çökmeden açmak somut, kanıtlanabilir bir hedef.

## Şimdiki ölçümler (P0-1 ve P0-2 sonrası)

Donanım: Apple M1, 16 GB, Chrome, stub IPC. Komut: `npm run bench:ui`. Rust tarafı: `cargo test --release --lib -- --ignored --nocapture timing`.

| Senaryo | Önce | Şimdi |
|---|---|---|
| 10.000 istekli koleksiyon, ilk satırlar | 10,2 sn, 140.774 DOM düğümü, ~180 MB | **0,49 sn**, 609 DOM düğümü, 48 MB |
| 50 MB yanıt, sayfa tarafı | 2,5–3 sn, 2,9 sn donma, 916 MB | **0,06 sn**, 35 ms donma, 44 MB, 744 DOM düğümü |
| 100 MB yanıt, sayfa tarafı | ölçülemedi | **0,05 sn**, 29 ms donma, 42 MB |
| 50 MB JSON, Rust tarafı (5,6 milyon satır) | – | açılış (biçimlendirme + indeks) **0,16 sn**, 50.000 eşleşmeli arama **12 ms** |

Bütçeler artık testte: `tests/ui/layout.test.mjs` içinde "budget:" testleri DOM düğümü ve satır sayısını (her makinede aynı) sınırlıyor, süreyi yalnızca çok gevşek sınırlıyor (CI'ı kararsız yapmasın). Rust açılış/arama bütçesi `timing_of_a_50_mb_body` testinde. Not: gerçek Tauri uygulamasında uçtan uca ölçüm henüz yok.

## Yeni öncelik sırası

**P0, performans ve kalite kapısı (önce bunlar):**
1. Koleksiyon ağacını **sanallaştır** (hedef: 10.000 istek < 1 sn ilk çizim, DOM'da yalnız görünen satırlar) ve metod etiketlerini tembel/önbellekli oku.
2. **Büyük yanıt hattı:** biçimlendirme ve arama Rust/Worker'da, görüntüleyici sanal, çok kopya yok, 100 MB+ için akıtma/diske yazma ve "ham aç" yolu. Hedef: 50 MB < 1 sn, donma yok, bellek < 3× boyut.
3. ~~Bench'i bütçeye çevir ve sonuçları donanımla birlikte yayınla.~~ **Yapıldı** (yukarıdaki tablo ve "budget:" testleri).
4. ~~UI test paketini büyüt: tüm modallar, diğer sekmeler, klavye odağı, erişilebilirlik (axe).~~ **Büyük ölçüde yapıldı:** axe-core (WCAG A/AA) ana ekranlarda, Settings/komut paleti, kod/AI panelinde ve tüm istek sekmelerinde, açık ve koyu temada temiz; modallar odağı içeri alıp tutuyor ve kapanınca geri veriyor; Tab ile Send'e ulaşılıyor ve odak halkası görünüyor. Runner, Mock, Defaults, Diff ve onay diyalogları da açık ve koyu temada axe'den temiz (taramanın bulduğu dört gerçek sorun düzeltildi: adsız ilerleme çubuğu, klavyeyle erişilemeyen kaydırmalı sonuç listesi, adsız karşılaştırma seçicileri ve editörleri, iki kontrast hatası). **Kalan:** gerçek ekran okuyucuyla (VoiceOver) elle deneme.

**P1, kanıtlı eksik özellikler:** yukarıdaki talep listesi 1–6 (yeniden kullanılabilir istek, jq filtresi, çoklu .env/ortam, sekme geliştirmeleri, anahtarlık + sır tarayıcı, OpenAPI export + HAR import) ve biçim şemasının yayınlanması (**yapıldı:** `website/schema/v1/*.schema.json` JSON Schema 2020-12, `docs/file-format.md`, `cairn validate`; serileştiricinin yazdığı her istek türü, içe aktarıcı çıktıları ve belgedeki her örnek şemadan geçiyor).

**P2:** Socket.IO/MQTT, OAuth2 cilası, Git arayüzü, doküman dışa aktarımı, erişilebilirlik geçişi, ağ taklidi.

---

# (Önceki) Yol Haritası


Amaç: Postman ve benzerlerinde **ücretli katmanda** olan özellikleri ücretsiz (ya da çok uygun fiyata) sunmak, ayrıca kullanıcıların talep ettiği ama onlarda olmayan şeyleri eklemek.

Bu liste kod tabanı taranarak çıkarıldı (kaynak: `src/lib/types.ts`, `src-tauri/src/*`, README). "Yok" dediklerim kodda arandı ve bulunamadı.

## Zaten var (Postman'de ücretli/hesap gerektiren)

Mock server, response history + diff, CLI/CI runner (JUnit/HTML), OpenAPI re-sync, gRPC, WebSocket, SSE, **MCP client**, GraphQL, kod üretimi (14 dil), cookie jar, git dostu YAML koleksiyonlar, hesap/bulut/telemetri yok.

## Tespit edilen eksikler

### P0: Temel eksikler (kullanıcı ilk gün fark eder)
| Eksik | Kanıt | Not |
|---|---|---|
| ~~multipart/form-data + dosya yükleme~~ **YAPILDI** | `BodyMode` artık `multipart` ve `binary` içeriyor; curl `-F` import, CLI desteği, kod üretimi (cURL/fetch/Python) | Kalan: diğer 11 dilde multipart kod üretimi, XML/HTML body modu |
| ~~Dinamik değişkenler~~ **YAPILDI** | `{{$guid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$date}}`, `{{$randomInt}}`, `{{$randomString}}`, `{{$randomEmail}}`, `{{$randomBoolean}}`; app, CLI, editör vurgulaması ve otomatik tamamlama | Kalan: `$randomInt(min,max)` gibi argümanlar, sahte isim/adres verisi |
| ~~Global / collection / folder değişken kapsamları~~ **YAPILDI** | Sıra: global < koleksiyon < klasör < environment < oturum. Koleksiyon/klasör `folder.yaml` içinde (CLI görür), global Settings'te | Kalan: değişkenin hangi kapsamdan geldiğini hover'da göstermek |
| **Windows ve Linux build** | `tauri.conf.json` targets: `app`, `dmg`; Release workflow'u sadece macos-14 | Kullanıcı tabanını belirleyen en büyük etken |
| **Otomatik güncelleme** | `updater` yok | Tauri updater plugin'i + imzalı release |
| **macOS imzalama/notarization** | Secret'lar tanımlı değil; ilk açılışta "sağ tık → Open" gerekiyor | Güven sorunu, Apple Developer hesabı gerekir |

### P1: Postman'den geçişi kolaylaştıranlar
| Eksik | Not |
|---|---|
| ~~`pm.*` script uyumluluğu~~ **YAPILDI** | `pm.test`, `pm.expect` (Chai alt kümesi), `pm.environment/variables/globals`, `pm.request`, `pm.response`, eski `tests[]`/`postman.*`; Postman importer scriptleri olduğu gibi taşıyor | Kalan: `pm.sendRequest`, `require()`, CryptoJS, cheerio |
| **Postman / OpenAPI'ye export** | Import var, export yok (yalnızca kod üretimi) |
| **Auth türleri: Digest, AWS SigV4, NTLM, Hawk, API key, JWT bearer üretimi** | Şu an Bearer, Basic, OAuth2 |
| **Contract testing** | Yanıtı OpenAPI/JSON Schema'ya karşı doğrula; OpenAPI zaten import ediliyor, doğal uzantı |
| **Koleksiyon dokümantasyonu export** (README'de roadmap'te) | Markdown/HTML, tek dosya, paylaşılabilir |

### P2: Postman'in ücretli duvarının arkasındakiler (farklılaşma alanı)
| Özellik | Fikir |
|---|---|
| **Monitors** (zamanlanmış çalıştırma) | Ücretli çekirdek özellik. Çözüm: CLI zaten var; GitHub Action cron örneği + isteğe bağlı yerel zamanlayıcı |
| **Yük / performans testi** | **CLI'da yapıldı:** `cairn bench` (N kullanıcı, süre veya istek sayısı, p50/p90/p95/p99, hata oranı, CI için `--max-p95` gibi sınırlar). Uygulama içi arayüz ve Rust çekirdeğiyle ölçüm yok; ölçüm Node'dan yapıldığı için istemci ~16.000 istek/sn'de tavan yapıyor (aynı makinedeki basit bir sunucuya karşı ölçüldü) |
| **Görsel akışlar (Flows)** | Capture + runner zaten zincirleme yapıyor; görsel editör sonra |
| **Takım senkronizasyonu** | Önerilen model: git zaten çalışıyor. Ücretli katman olarak self-host sync sunucusu (README'de planlı) |
| **Gizli bilgi taraması** | Commit öncesi koleksiyonda token/anahtar yakalama; secrets zaten ayrı dosyada |
| **Secret'lar için macOS Keychain** | Şu an `.cairn/secrets.yaml` düz dosya |
| **Ek protokoller**: SOAP/WSDL, Socket.IO, MQTT | İstek geldikçe |

### P3: Sağlamlaştırma
- `tauri.conf.json` içinde `"csp": null`: CSP tanımlanmalı (script worker izolasyonu iyi, ama webview'in kendisi açık).
- CI'da sadece `cargo test --lib` ve tsc var; frontend ve CLI dışında UI testi yok.
- Release pipeline'ı bir kez de olsa deneme tag'iyle (örn. `v0.1.0-rc1`) doğrulanmalı.

## Önerilen sıra

1. **multipart/form-data + dosya body** (P0, en görünür boşluk, küçük iş)
2. **Dinamik değişkenler + değişken kapsamları** (P0)
3. **Windows/Linux CI build** + otomatik güncelleme (P0, dağıtım)
4. **`pm.*` shim + Postman export** (P1, geçiş için)
5. **Digest / SigV4 / API key auth** (P1)
6. **Contract testing** (P1, ayırt edici)
7. **Monitors + yük testi** (P2, ücretlendirilebilecek katman)

## Fiyatlandırma notu

Çekirdek uygulama ücretsiz kalırsa (yerel-öncelikli, hesap yok), ücretli katman için en doğal adaylar: self-host takım sync'i, zamanlanmış monitor'lar (barındırılmış) ve yük testi. Bunlar sunucu maliyeti doğuran, bireysel kullanıcıyı etkilemeyen kalemler.
