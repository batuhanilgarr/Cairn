# Reqnest Yol Haritası

Amaç: Postman ve benzerlerinde **ücretli katmanda** olan özellikleri ücretsiz (ya da çok uygun fiyata) sunmak, ayrıca kullanıcıların talep ettiği ama onlarda olmayan şeyleri eklemek.

Bu liste kod tabanı taranarak çıkarıldı (kaynak: `src/lib/types.ts`, `src-tauri/src/*`, README). "Yok" dediklerim kodda arandı ve bulunamadı.

## Zaten var (Postman'de ücretli/hesap gerektiren)

Mock server, response history + diff, CLI/CI runner (JUnit/HTML), OpenAPI re-sync, gRPC, WebSocket, SSE, **MCP client**, GraphQL, kod üretimi (14 dil), cookie jar, git dostu YAML koleksiyonlar, hesap/bulut/telemetri yok.

## Tespit edilen eksikler

### P0: Temel eksikler (kullanıcı ilk gün fark eder)
| Eksik | Kanıt | Not |
|---|---|---|
| ~~multipart/form-data + dosya yükleme~~ **YAPILDI** | `BodyMode` artık `multipart` ve `binary` içeriyor; curl `-F` import, CLI desteği, kod üretimi (cURL/fetch/Python) | Kalan: diğer 11 dilde multipart kod üretimi, XML/HTML body modu |
| **Dinamik değişkenler** (`{{$randomInt}}`, `{{$timestamp}}`, `{{$guid}}`) | Kodda yok (mock tarafında `$uuid` var) | İstek gövdelerinde sık kullanılıyor |
| **Global / collection / folder değişken kapsamları** | `global` sadece stream/openapi içinde geçiyor | Şimdilik sadece environment var |
| **Windows ve Linux build** | `tauri.conf.json` targets: `app`, `dmg`; Release workflow'u sadece macos-14 | Kullanıcı tabanını belirleyen en büyük etken |
| **Otomatik güncelleme** | `updater` yok | Tauri updater plugin'i + imzalı release |
| **macOS imzalama/notarization** | Secret'lar tanımlı değil; ilk açılışta "sağ tık → Open" gerekiyor | Güven sorunu, Apple Developer hesabı gerekir |

### P1: Postman'den geçişi kolaylaştıranlar
| Eksik | Not |
|---|---|
| **`pm.*` script uyumluluğu** | Scriptlerde `req/res/env/expect` var, `pm.` yok. Import edilen Postman koleksiyonlarındaki scriptler çalışmaz. İnce bir `pm` shim'i (pm.environment, pm.response, pm.test, pm.expect) geçişi büyük ölçüde açar |
| **Postman / OpenAPI'ye export** | Import var, export yok (yalnızca kod üretimi) |
| **Auth türleri: Digest, AWS SigV4, NTLM, Hawk, API key, JWT bearer üretimi** | Şu an Bearer, Basic, OAuth2 |
| **Contract testing** | Yanıtı OpenAPI/JSON Schema'ya karşı doğrula; OpenAPI zaten import ediliyor, doğal uzantı |
| **Koleksiyon dokümantasyonu export** (README'de roadmap'te) | Markdown/HTML, tek dosya, paylaşılabilir |

### P2: Postman'in ücretli duvarının arkasındakiler (farklılaşma alanı)
| Özellik | Fikir |
|---|---|
| **Monitors** (zamanlanmış çalıştırma) | Ücretli çekirdek özellik. Çözüm: CLI zaten var; GitHub Action cron örneği + isteğe bağlı yerel zamanlayıcı |
| **Yük / performans testi** | Runner üzerine N eşzamanlı kullanıcı, p50/p95/p99. Rust çekirdeği için uygun |
| **Görsel akışlar (Flows)** | Capture + runner zaten zincirleme yapıyor; görsel editör sonra |
| **Takım senkronizasyonu** | Önerilen model: git zaten çalışıyor. Ücretli katman olarak self-host sync sunucusu (README'de planlı) |
| **Gizli bilgi taraması** | Commit öncesi koleksiyonda token/anahtar yakalama; secrets zaten ayrı dosyada |
| **Secret'lar için macOS Keychain** | Şu an `.reqnest/secrets.yaml` düz dosya |
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
