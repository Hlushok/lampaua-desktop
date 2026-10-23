# Тестова LampaUa Desktop Із D3D11

Це локальний Windows x64 кандидат, а не опублікований реліз. Версію,
production runtime manifest, установлений додаток і канал оновлень не змінено.

## Запуск І Збирання

Повний додаток: `dist/mpv-desktop-d3d11-test/win-unpacked/LampaUa Desktop MPV Test.exe`.
Потрібна вся папка `win-unpacked`, не тільки EXE.

```text
node scripts/build-win-mpv-test.cjs --d3d11 --candidate-sdk .cache/libmpv-d3d11-candidate/sdk --unpacked
```

Прапорець `lampauaMpvD3d11Test` встановлюється тільки в тестовому пакеті.
Профіль: `LampaUaDesktopMpvD3d11Test[-run-id]`; вихідні файли й кеш також окремі.
`--release --d3d11` заборонено. Перевіряються DLL, SDK, джерела, manifest,
effective source tree та всі 827 ліцензійних файлів із замороженого комплекту.
Точні ідентифікатори записані в `build/libmpv-d3d11-test.json` та
`docs/mpv-d3d11-candidate.md`.

## Поведінка

- Перевагу D3D11 задає довірений main process, не віддалена сторінка.
- Renderer отримує тільки VideoFrame та безпечні метадані, без NT handles і
  transfer/sync tokens. ACK перевіряє власника, main frame і точний lease.
- Ініціалізація асинхронна; паралельний create не обходить single-session
  обмеження. Закриття, навігація та renderer crash скасовують пізній результат.
- При помилці GPU виконується не більше одного переходу на software. Адреса,
  заголовки, пауза, гучність, швидкість та чинні вибрані доріжки зберігаються.
  Для VOD відновлюється підтверджена позиція. Для live або невідомої тривалості
  автоматичного VOD seek немає.
- Запити швидких перемотувань/resize об'єднуються; це не дозвіл створювати
  необмежені покоління текстур. Усі ліміти active/retired leases залишаються.
- Закриття UI не чекає непідтвердженого GPU lease. Native owner утримується до
  GPU-safe release; таймер не звільняє слот. Поки owner має retired transport,
  повторне відкриття використовує software, а не небезпечне повторне використання.
- На старій `http://lampaua.mooo.com/` фактично немає `navigator.gpu`
  (`isSecureContext=false`), тому працює WebGL/software. Протокол не змінюється
  і перевірки безпеки браузера не вимикаються. На `https://kinohub.uk/`
  підтверджено D3D11; після повернення на HTTPS він знову доступний.

## Перевірено 23.10.2026

Інтеграційний контракт: late init cancellation (navigation/crash/detach/dispose),
pending render після seek/close, 50 create/resize/seek/close, foreign ACK,
GPU-safe retirement, одноразовий fallback, signed URL/custom headers,
підтверджена позиція, pause, volume, speed, audio/subtitle, live без seek.
Також пройдені transport unit, IPC, renderer, test isolation, Lampa, Ytdl та
external-player contracts на свіжо скомпільованому TypeScript.

Повний Desktop QA: `.cache/mpv-desktop-d3d11-test/evidence/run-1792731758489/`.
H264/AAC, AC3/EAC3, Xvid, browser DASH 720→1080 із окремими A/V сегментами,
native DASH, IPTV HLS/TS/live HLS, підписаний IPTV proxy, захищені MP4/HLS,
очищення заголовків наступного джерела, HTTP 403/404/503, завислі відповіді,
скасування мережі, аудіодоріжки/субтитри/mute, збереження/відновлення позиції,
reload, обидві адреси, offline error page/recovery. Цикли software stress: 20,
134–219 мс. Чистий вихід: renderer 309 мс, процес 1475 мс, код 0; metadata
production профілю не змінена. Намірено некоректні потоки не є збоєм QA.

Окремі 4K/control та positive-quality результати від 22.10:
`run-1792700810516` і `run-1792700958894`. 24 швидкі seek/pause/play завершилися
в `d3d11` / `d3d11va`, максимальний control round-trip 27 мс.

## Ще Не Підтверджено

Інтеграційний PASS не доводить тривалу плавність 4K. Залишаються Task 7:
строгі cadence windows, безперервні ≥180-секундні fixtures, compositor/pixel
evidence, реальний 86.47-ГБ торент на 25:10–25:30 та підтвердження користувача,
фінальне незалежне рев'ю. До їх завершення кандидат не просувається в реліз.

## Подальші Оновлення

Зміна JS або Electron не вимагає повторного збирання MPV DLL: перевикористати
перевірений SDK, перебудувати addon під ABI Electron та повторити contracts,
GPU transport/native й повний Desktop QA. Зміна MPV/FFmpeg/патча потребує
окремого pinned source/preflight/build/source-closure циклу. Прийнятий runtime
не замінюється автоматично candidate-файлами. Відкат: закрити тестовий EXE та
запустити встановлену LampaUa; її файли й профіль залишаються окремими.
