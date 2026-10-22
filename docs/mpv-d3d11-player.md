# MPV D3D11: Native Player Acceptance

Стан на 22.10.2026: реалізований native backend (Task 5). Це ще не готовий
Desktop-пакет і не підтвердження виправлення реального 4К-торента.

## Контракт

- `createD3d11Player({width,height})` повертає Promise готового плеєра.
  Прямий `new MpvPlayer({mode:'d3d11'})` заборонений.
- MPV init/render/context free та D3D immediate context належать окремому
  render thread. Головний потік виконує лише неблокувальні керувальні команди.
- Повторно використовується чинна черга open/headers/controls/events, включно
  з HTTP/HTTPS protocol whitelist і припиненням черги після помилки.
- Три BGRA8 GPU-текстури на покоління, щонайбільше два покоління. Кадр має
  точний ключ slot/generation/sequence. Повторний або чужий release не приймається.
- Native D3D11 render не повертає CPU RGBA. Вихід SDR BT.709/sRGB;
  HDR passthrough не заявляється.
- `destroy()` ідемпотентний. Pending render утримує owner; після запиту закриття
  кадр відкидається, а очікування target time скасовується.

Важлива умова інтеграції Task 6: перед native destroy усі передані Electron
leases мають безпечно завершитися. Якщо renderer не підтвердив release,
transport зберігає native owner у bounded quarantine, а не викликає destroy
через тайм-аут. UI disposal не повинен чекати такого renderer.

## Timing

Реальний candidate `vo_libmpv.c` записує nanoseconds у `target_time`; це
перевірено проти `mpv_get_time_ns` і міжкадрових інтервалів, незалежно від
застарілої згадки microseconds у коментарі header.

Рендер виконується з `BLOCK_FOR_TARGET_TIME=0`, потім перевіряється GPU
completion і лише потім на render thread очікується target time. Це прибирає
очікування GPU після CPU-блокування до часу показу. Advanced control вимкнений;
`report_swap` не викликається без доказу presentation.

Телеметрія розділяє CPU submission, GPU completion wait, target wait та D3D11
timestamp-query elapsed time. Disjoint або ще не готова query дає `null`, а
не зупиняє відео. Ці показники не є physical presentation timestamps.

## Перевірки

Використаний незмінний SDK з run `39726751671`, build commit
`530ed50499e4afeed19b8070f149dc5bb1818931`; hashes наведені в
`mpv-d3d11-candidate.md`. DLL повторно не компілювалася для Task 5.

Повний native test `task5-close-green.log`:

- H264: 48 виміряних кадрів, нових video/decoder drops 0/0,
  max absolute avsync 1.80 ms.
- HEVC Main10 HDR 3840x2160: 240 кадрів, `d3d11va`, GPU pixel format `d3d11`,
  WASAPI audio, нових video/decoder drops 0/0, max avsync 10.69 ms.
- GPU timestamp samples 48/48 та 240/240; heartbeat max gap 24.05 ms.
- Header-protected HTTP color reference: SDR red pixel 254, без CPU pixels
  у playback API; readback існує лише в test build.
- 50 open/seek/GC/close cycles, close during pending render, callback exception,
  disjoint timing та device-removed paths; наприкінці 0 textures/handles/threads.
- Негативний runtime API 2.5 тест, старі API 2.5 headers build, software native
  lifecycle, pool/resize/fault tests, TypeScript/transport unit та чинні
  ownership/renderer contracts пройшли.
- Production build успішний, test-only exports і prototype methods відсутні.

Окремий native VO control на тому самому HEVC fixture: clock ratio 0.99972,
drops 0/0, avsync 0.12 ms. Це не замінює Desktop/compositor acceptance.

Чесна межа доказів: один повторний строгий HEVC run дав 2 нові video drops
після warmup і був відхилений, а не прийнятий зі слабшими порогами. Останній
повний run пройшов. Тривалі повторні 30-секундні cadence windows, повний Desktop,
справжній 86.47-ГБ торент та видимий compositor належать Task 7 і ще не прийняті.
macOS native compile на цій Windows-машині не виконувався; нові D3D11 sources
включаються тільки у Windows condition, API 2.6 calls захищені header guards.

## Повторення

```text
node scripts/create-mpv-stream-fixtures.cjs --d3d11-color
node scripts/verify-mpv-d3d11-native.cjs --player-tests --addon .cache/libmpv-d3d11-player-addon/mpv_addon.node --sdk .cache/libmpv-d3d11-candidate/sdk --build-commit 530ed50499e4afeed19b8070f149dc5bb1818931
node scripts/verify-mpv-d3d11-native.cjs --player-tests --production-only --addon .cache/libmpv-d3d11-production-addon/mpv_addon.node --sdk .cache/libmpv-d3d11-candidate/sdk --build-commit 530ed50499e4afeed19b8070f149dc5bb1818931
```

`--player-lifecycle-only` відділяє перевірки lifetime/fault від вимірювання
плавності, але не є passing performance evidence. Accepted SDK, installed
Desktop/profile, сервер, релізи та updater у цьому етапі не змінювалися.
