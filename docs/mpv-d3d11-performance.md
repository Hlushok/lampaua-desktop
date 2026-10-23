# Перевірка D3D11: Орієнтація Та Плавність

Стан на 23.10.2026: виправлено орієнтацію, три 180-секундні 4К cadence-прогони
та ручна перевірка 80+ ГБ BDRemux пройшли. Це локальний кандидат, не реліз;
окремі межі доказів і результати фінального QA наведено нижче.

## Орієнтація

Користувач помітив перевернуті цифри. На знімку реального вікна лічильник із
нижнього лівого кута джерела був угорі догори дриґом. Причина: координати Y
текстури VideoFrame та WebGPU clip space були зіставлені без потрібної інверсії.
Змінено тільки UV у GPU-шейдері; горизонтальну орієнтацію не змінено.

Додано асиметричний H264-зразок: червоний/зелений верх, синій/жовтий низ та
напис `TOP LEFT 1234`. Перевірка реальних screenshot pixels була RED до зміни
шейдера та GREEN після. Кольори нормалізуються перед класифікацією: панель
Lampa затемнює відео, але не змінює розташування кутів. Порожній кадр відхиляється.
Знімок переглянутий: напис і цифри читаються нормально.

```text
node scripts/create-mpv-stream-fixtures.cjs --d3d11-orientation
node scripts/verify-mpv-desktop.cjs --d3d11 --orientation-only --exe "dist/mpv-desktop-d3d11-test/win-unpacked/LampaUa Desktop MPV Test.exe"
```

GREEN evidence: `.cache/mpv-desktop-d3d11-test/evidence/run-1792733591811/`.
Попередню збірку збережено в
`.cache/mpv-desktop-d3d11-test/pre-orientation-win-unpacked-20261023/`.

## Строгі Метрики

`scripts/mpv/performance-metrics.cjs` не рахує REDRAW/REPEAT як нові відеокадри,
відхиляє повторні sequence/target timestamps та повернення старого generation.
Відсутні FPS або телеметрія, скидання drop counters, buffering і помилка не
дають PASS. Тести охоплюють 24, 24000/1001, 25, 30000/1001, 50 і 60 FPS.

Пороги не знижено: щонайменше 98% унікальних кадрів джерела, не більше одного
нового пропуску кожного типу за 30 с, max gap до трьох інтервалів джерела плюс
один інтервал дисплея, clock ratio 0.98–1.02, UI RAF щонайменше 90% idle,
absolute AV sync до 50 мс після прогріву. Тривалий тест перевіряє кожне
30-секундне вікно, а не тільки середнє за весь запуск.

Метадані прив'язані до реального renderer callback із перевіркою player id.
Consumer arrival та GPU submission не називаються фізичним показом кадру.
GPU-safe release timestamp не відкривається сторінці: у frame samples це
явний `null`, а не вигаданий час завершення. Окремий transport gate перевіряє
leases/sync tokens/GPU release та compositor markers. Знімки повного Desktop
окремо перевіряють, що зображення непорожнє та змінюється.

## Безперервні Зразки

Усі три файли мають 3840×2160, 24 FPS, 192 с, AAC та візуальний лічильник
кадрів/синхронні 1-Гц flash-click маркери. Коротке відео не зациклюється.
Генератор: `scripts/create-mpv-stream-fixtures.cjs --d3d11-continuous`.
Кольорові VUI-поля записуються також через codec metadata bitstream filter:
одних container/encoder flags було недостатньо для цієї QSV-збірки.

| Файл                            | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `d3d11-continuous-h264-sdr.mp4` | `21be4f1af37a23ed398166bcc74847f0a4b6363d640d91d7bedd95e49a49e724` |
| `d3d11-continuous-hevc-sdr.mp4` | `e515414b32256f1860ffe7ba34bf2d60286a188c097f56f82e7f40e75f6a5a0e` |
| `d3d11-continuous-hevc-hdr.mp4` | `82582b0904debe8fc59dc46e7f616e02fde2cebd591d78ba6eaa4214e94158df` |

HDR-зразок має HEVC Main10/P010, BT.2020/PQ. Це синтетичний pattern для
декодера, timing та tone-mapping path, не еталон колориметрії HDR-дисплея.
Рецепт, ffprobe metadata, SHA і перевірка різних кадрів збережені біля файлів
у `.cache/mpv-prototype/fixtures/*.mp4.json`.

## Відхилені Результати

Перший повний HDR-замір `run-1792733082946` був RED: 20.526/24 унікальних FPS,
104 video drops, 0 decoder drops, UI RAF ratio 0.825, clock 0.9999, AV sync
0.232 мс, без buffering. Наявність d3d11va не означає, що весь renderer плавний.
У виведенні MPV `video-params/pixelformat=d3d11` означає GPU-контейнер кадру,
а `video-params/hw-pixelformat=p010` — формат його площин. Їх не можна міняти
місцями у перевірці zero-copy.

Native-only polling probe без Electron показав значний GPU-час на тому самому
джерелі: P95 34.06/37.45/40.48 мс для 640×360/1483×944/1920×1080. Це окремий
best-case probe, не приймання Desktop і не висновок про недостатній CPU.
Проба з одним `hdr-compute-peak=no` не дала стабільного покращення та не
перенесена в кандидат. Окремий стандартний `fast`-профіль зменшив native GPU P95
до 6.29/11.99/16.41 мс для тих самих трьох вихідних розмірів, із нулем пропусків.
Повтор незміненого профілю дав 43.55/40.01/36.05 мс. Це не тест CPU.

Повна діагностична копія Desktop із `fast` та виправленою орієнтацією пройшла
30-секундний HDR-тест `run-1792735061274`: 23.999/24 унікальних FPS, 0/0 drops,
max gap 63.7 мс, clock 0.99996, UI RAF ratio 0.99275, AV sync до 0.095 мс.
GPU-обробка та tone mapping залишаються, роздільність джерела не знижується.

Профіль `fast` — спільна політика D3D11, не таблиця винятків для фільмів. За
точним `mpv/etc/builtin.conf` він використовує bilinear scale/dscale, вимикає
дороге лінійне/коректоване зменшення, sigmoid upscaling, dithering та покадровий
HDR peak analysis. Це обмін складності обробки на швидкість, а не обіцянка
математично ідентичного зображення. HDR перетворюється у BGRA8 SDR за чинними
target primaries/TRC. Фактичне зображення і чотири кути перевірені; остаточне
приймання довгого відтворення та реальної сцени ще попереду.

Read-only перевірка WebGPU на цій машині: default/low-power/high-performance
повернули Intel gen-9. Не підтверджено, що причиною є міжадаптерне копіювання.
Windows GPU settings, драйвери й налаштування сервера не змінювалися.

## Видимість Під Час Тесту

Довгі H264-прогони поки не прийняті. В одному RAF впав до нуля; у повторі
журнал прямо зафіксував `visibility: hidden` приблизно через 23 с після початку
заміру. Приховані інтервали не відкидаються, пороги не знижуються. Причину
приховування треба встановити та повторити замір у видимому вікні.

Автотест запускає test-entry із `--mpv-test-window-log`: тільки ця явна опція
вмикає журнал show/hide/minimize/restore/focus/blur. Always-on-top прибрано після
повідомлення користувача про вікно, що перекривало інші програми; старий
`--mpv-test-visible` більше не має ефекту. Production bootstrap цю test-entry
не допускає. Вікно не закріплюється поверх інших та не відновлюється насильно.
Samples містять visibility та focus; невидимий sample відхиляє приймання.

Read-only перевірка: живлення Online, AC display timeout 0 (вимкнено), DC 180 с;
залишених тестових main-процесів після прогону немає. Налаштування живлення не
змінювалися. Це не підстава оголошувати причиною CPU чи автоматичне засинання.

Користувач підтвердив, що під час попереднього приховування його не було біля
комп'ютера. Згортання користувачем не є встановленою причиною. Новий прогін
`run-1792740828763` був видимий і focused весь час, без hide/minimize подій,
але отримав 12 video drops та gap 735.4 мс. Отже, видимість не пояснює всі збої.

## Повторні Перевірки

Фінальну чисту збірку з `fast` перевірено окремо від старих незакомічених
software-performance змін: orientation `run-1792737001802`, controls
`run-1792737019841`, full desktop smoke `run-1792737041515` — PASS.
Native test addon з тих самих staged джерел пройшов H264/HEVC, fault injection
та 50 lifecycle cycles; після close texture/handle/thread counts дорівнюють 0,
main heartbeat max 30.2 мс, video/decoder drop deltas після warmup 0/0.

`--trace-performance` є додатковою діагностикою, не окремим доказом приймання.
Використовується browser CDP, gzip stream із лімітом 128 МіБ compressed / 512 МіБ
expanded та renderer TimeStamp для зіставлення годинників. Повний GPU/benchmark
trace переповнював буфер на довгому прогоні; це відхилений результат, не PASS.
Вузький набір timeline/V8/frame категорій зберіг 60-секундний trace.

У ньому `run-1792741498082` cadence пройшов обидва 30-секундні вікна: 23.999/24
unique FPS, 0/0 drops, max gap 103.1 мс, RAF ratio 0.988, AV sync 0.064 мс.
Це не скасовує попередній RED. Compositor summary цього trace не має повного
CanvasAnimation coverage і не прийнятий. Навіть повні Display::FrameDisplayed
події включають 60-Гц UI Lampa, тому не можна прирівнювати їх до 24 унікальних
кадрів відео або подавати загальний counter як physical video presentation.

Timeline показав 43–60-мс TimerFire/FunctionCall у `lampainit.js`; read-only
перевірка точного коду підтвердила синхронний XHR у `accessState()`, викликаний
гостьовим monitor кожні 3 с. Це підтверджене окреме джерело затримки UI тестового
гостьового профілю, але не доказ причини попереднього gap 735 мс чи дефекту
авторизованого користувача. Сервер, авторизація й модулі не змінювалися.
Тривалі заміри додатково зберігають long-task та `/testaccsdb` timing без URL,
query або credentials. Приховані інтервали, мережеві затримки й drops не
видаляються із samples; метрики та пороги незмінні.

Останній 180-секундний H264-прогін `run-1792741947180` залишився RED: 23.978/24
unique FPS, 4/0 drops, max gap 324.5 мс. Весь час visible/focused. Обидва gaps
понад 140 мс збіглися з long tasks та запитами `/testaccsdb`: 267 мс для gap
324.5 мс і 180+73 мс для gap 272.6 мс. Це пряме свідчення блокування UI
синхронним guest XHR у цьому прогоні; його не відкинуто з метрик.

Для наступних вимірювань додано `--reuse-test-profile`: тільки unpacked package
з обома test flags і `src/mpv-test-main.js`, не `--release`. Він використовує
наявний окремий `LampaUaDesktopMpvD3d11Test`, не копіює production data й не
імітує успішну авторизацію. Спочатку треба увійти в тестовому вікні, потім
закрити його перед автоматичним запуском, щоб не було second-instance конфлікту.
Контракти відхиляють release/foreign packages; відсутній `--exe` тепер також
відхиляється до будь-якого запуску. Початковий CLI regression був RED, після
зміни guard — GREEN.

Повний поточний додаток: `dist/mpv-desktop-d3d11-test/win-unpacked/`.
Копія звірена з чистим build за SHA-256 executable/addon/DLL/renderer.
Попередня збережена в
`.cache/mpv-desktop-d3d11-test/pre-nonblocking-win-unpacked-20261023/`.
SHA-256 addon: `0b6bdd6cd3a1ac2bf7e110ca669c01e7a0c41cbe529552472bd88dd29e2ce935`.
Сам `.exe` є Electron launcher, а не самодостатній інсталятор; потрібна вся
папка збірки. Production manifests, інстальований Desktop і канали оновлення
не змінювалися. Тестове вікно залишене користувачу для входу.

## Неблокувальний Запуск

Попередній ручний запуск мав `--mpv-test-visible`, always-on-top та Windows
startup style Hidden. Користувач повідомив про білий екран і неможливість
працювати з іншими вікнами. Його точний test PID 22000 перевірено за шляхом
та штатно закрито через `electronAPI.closeApp()`; залишкових test-процесів
не було. В інстальований Desktop або production profile втручання не було.

Always-on-top повністю вилучено з test entry; старий прапорець нічого не
вмикає. Новий `--mpv-test-window-log` тільки журналює події. Regression
assertion був RED на старому `setAlwaysOnTop(true)`, потім GREEN для normal,
legacy-flag та log-flag запусків. Повний clean-index build зібраний заново,
включно з native lifecycle/staging checks; коренева копія звірена за hashes.
Test-entry SHA-256: `03339bd7a90b4639380c6b00cfd56a5df0a4a7dbf075b98eeb34390e686b851e`.

Після звичайного Windows launch через Computer Use реальний window capture
показав каталог з постерами, не білий екран. Користувач підтвердив вхід і
сам запустив 4К. Перевірка хрестика не зарахована: інструмент двічі виявив
ввід користувача і не виконав click; після початку відео закриття скасоване.

У журналі старого процесу був GPU exit code 34 —
[втрата GPU context](https://chromium.googlesource.com/chromium/src/+/4daefb42d0ebc7c5f5b595296f16d8b3469649cc/components/viz/service/gl/exit_code.h).
Це окреме спостереження, не встановлена причина початкового білого екрана
й не доказ помилки DLL. GPU restart/recovery ще не прийнятий окремим тестом.

Авторизований ручний запуск: main PID 8044, GPU 23348, renderer 10640.
TorrServer віддав файл 37 987 700 144 байти; це не попередній 80+ ГБ варіант.
MPV diagnostic зафіксував open/file-loaded, без fallback/error на час читання.
Три Windows GPU samples 09:14:50–09:14:53 UTC показали VideoDecode процесу
8044 = 29/27/57%; його 3D і Chromium GPU 3D на тому самому LUID 0:1432c.
Це доказ активного hardware decode, не proof FPS/zero-copy/physical present.
Нормальний запуск без CDP не дає цьому verifier покадрової телеметрії; не
вигадувати cadence або drop counts. Поточний ручний сеанс не переривається;
очікується відгук користувача щодо плавності й керування.

Користувач після цього підтвердив: «Плавно, керування працює». Це ручний PASS
цього 4К-запуску, не приймання старого 80+ ГБ файла чи виміряних 180-секундних
cadence windows. Після ручних запусків MPV журнал показав штатний
destroy-complete, без fallback/error; останній read-only список TorrServer
порожній. Надіслано прохання окремо повторити проблемний BDRemux на 25:10–25:30.

Потім користувач окремо підтвердив проблемний 80+ ГБ BDRemux на запитаній
сцені: «перевірив, працює». Це закриває ручну перевірку сцени/керування;
покадровий замір і трихвилинна безперервна перевірка реального потоку цим
повідомленням не доведені. Після handback новий native capture показав діалог
файла 80.54 ГіБ, а MPV log — штатний destroy-complete без fallback/error.
Тестове вікно активовано окремо від Codex, закрито його власним хрестиком;
повторний native window list і список процесів порожні. Native close PASS.

## Залишається

Ручна перевірка проблемної сцени та native close пройшли. Залишаються строгі
тривалі cadence-прогони, video-specific presentation evidence, GPU-process
recovery та виміряні три хвилини реального потоку. Не прирівнювати ручне
підтвердження сцени до цих окремих метрик.

## Після Ручного Приймання

Авторизований H264-прогін `run-1792748634032` залишився RED: 23.882/24 FPS,
24/0 drops, max gap 183.9 мс. Вікно visible/focused, long tasks і guest XHR
під час вимірювання відсутні. Затримки доставки кадрів повторювалися приблизно
кожні 1.65 с, тоді як RAF продовжував працювати. Це не доказ нестачі CPU або
серверного дефекту. Короткий діагностичний прогін із main profiler
`run-1792749386730` був кращим: 30 с, 24.001 FPS, 0/0 drops, max gap 65.2 мс;
main переважно idle. Затримка там не відтворилася, тому профіль не пояснює
попередній RED і не замінює 180-секундного приймання.

Фінальний reviewer виявив чотири крайові випадки. Кожний спочатку відтворено
регресійним тестом, потім внесено bounded fix:

- Retired MPV з непідтвердженою GPU lease не повинен залишати звук/мережу.
  Новий native `retireD3d11Playback()` скасовує pending command queue та
  підтверджує `idle-active` після stop у worker, не на JS/render thread.
  Текстури звільняються тільки після GPU completion; destroy чекає worker.
- Покоління GPU монотонне в межах session, включно з D3D11 → software →
  D3D11. Новий transport отримує той самий новий generation floor.
- Позитивні duration/seekable не доводять VOD: HLS EVENT може мати обидва.
  Спостерігається фактичний `file-format`, у тому числі для masked URL;
  автоматичний fallback seek дозволений лише для відомих finite-file
  контейнерів. HLS/DASH/unknown не отримують seek. Це консервативно також
  відмовляється від автоматичного відновлення непідтвердженого HLS VOD,
  але не вимикає ручне перемотування. DLL/API не змінюються.
- Cadence helper тепер вимагає explicit measurement start/end, враховує
  head/tail gaps і ділить кількість унікальних кадрів на повний інтервал.
  800-мс зависання наприкінці вікна більше не може дати PASS; кожне
  30-секундне вікно прив'язане до початку вимірювання, не першого кадру.

Integration і metrics regressions RED → GREEN. Native retirement regression
на попередньому addon був RED (`retireD3d11Playback is not a function`);
його перевірка на перебудованому addon і повторний повний QA ще потрібні.
Зміни зберігаються в candidate index окремо від старих software-performance
напрацювань; push, tag, release, production manifests і updater не змінені.

## Повторний Тривалий QA

Після fixes повний `task7-review-final-build.log` завершився з кодом 0.
Повторні TypeScript, вісім JS contracts, transport unit, `yarn lint` та 81
source/preflight тести пройшли. Native H264/HEVC і 50 lifecycle cycles:
0/0 drops після warmup, texture/handle/thread counts 0/0/0, main heartbeat
max 40.1 мс. Retirement з retained texture, вимкненим event pump і pending
commands, а також concurrent retirement/destroy перевірені окремо.

Авторизовані 180-секундні прогони з explicit boundaries, без паралельного
відтворення або builds:

| Input                 | Run                 | Unique FPS | Video/decoder Drops | Max Gap | Windows  |
| --------------------- | ------------------- | ---------- | ------------------- | ------- | -------- |
| H264 SDR              | `run-1792751264423` | 23.999/24  | 0/0                 | 74.4 мс | 6/6 PASS |
| HEVC SDR              | `run-1792751496438` | 23.998/24  | 0/0                 | 79.6 мс | 6/6 PASS |
| HEVC Main10 HDR → SDR | `run-1792751738094` | 23.992/24  | 0/0                 | 94.3 мс | 6/6 PASS |

У всіх випадках `d3d11` / `d3d11va`, playback clock близький до 1.0,
RAF понад 99% idle, AV sync <0.1 мс; без buffering, media errors і прихованих
інтервалів. Це consumer-arrival/GPU-submit cadence, не підміна physical
video presentation загальним compositor FPS. Попередні RED прогони збережені;
їхня відсутність у новому прогоні не доводить причинного виправлення старих
періодичних gaps.

Окремий GPU recovery `run-1792756289833` був RED: після навмисного
`Browser.crashGpuProcess` тестової LampaUa fallback/time/pause/seek працювали,
але pixel checks показали чорне відео. Software output обрав старий WebGL
контекст, втрачений разом із GPU process. Доданий sticky context-loss guard
та перевірка `isContextLost()` не дозволяють повторно використовувати його:
fallback вибирає Canvas2D, справний WebGL не вимикається. Contract спочатку
RED (`webgl` замість `canvas2d`), потім GREEN. Окремий контракт перевірив
фактичний compiled getter, події `webglcontextlost/restored` та sticky
відмову від старих GPU resources, не лише stub `available`.

Повторний реальний GPU-loss `run-1792756712646` — PASS: software/Canvas2D,
позиція 11.75 → 12.708 с до ручного seek, pause/seek/play працюють, pixel mean
126.8 і delta 4.13 підтверджують змінне непорожнє зображення. Повна перевірка
recovery + controls тривала 7.7 с, закриття процесу 917 мс, код 0. Це навмисний
збій тільки GPU process test-додатка, не звичайна помилка відтворення.

Користувач додатково підтвердив безперервні ≥3 хвилини проблемного 80+ ГБ
BDRemux, включно з 25:10–25:30: усе плавно. Цим закрито ручний довгий тест.
Окремої покадрової телеметрії саме цього реального файла не знято.

Під час final full QA негативні DASH/HTTP 403 перемикання виявили очікування
retirement без дедлайну. Тимчасовий diagnostic run `run-1792757118355`
показав завершення frame drain за 0–1 мс, після чого `retirePlayer` не
повертався >20 с. Native-only 90 failed-source циклів цього не відтворили;
внутрішню причину libmpv wakeup не заявлено доведеною.

Прибрано необмежений `mpv_wait_async_requests()`: retirement worker сам
споживає reply поточної скасованої команди, потім reply stop з єдиним
5-секундним дедлайном. Main `pollEvents()` після початку retirement повертає
порожній batch, тому client queue має лише одного reader. Підтвердження idle,
GPU-safe texture drain і native owner lifetime збережені. Додано статичний
RED → GREEN guard та 8 runtime failed-source/reply-ownership циклів.
Тимчасові compiled diagnostic logs не входять у source чи фінальний пакет.

Idle підтверджується також асинхронно (`GET_PROPERTY_REPLY`) під тим самим
дедлайном; синхронний core property query не використовується. Timeout є
помилкою, не підтвердженням stop, і не дозволяє звільнення GPU lease таймером.
Повторний final native suite — PASS: 8 failed-source циклів, H264/HEVC,
50 lifecycle/fault cycles; resources 0/0/0, heartbeat max 30.9 мс.

## Фінальний Локальний Пакет

Повна збірка: `dist/mpv-desktop-d3d11-test/win-unpacked/LampaUa Desktop MPV Test.exe`.
Потрібна вся папка `win-unpacked`, не лише Electron launcher `.exe`.
Окремий профіль `LampaUaDesktopMpvD3d11Test` збережений; його updater вимкнений.
Встановлена LampaUa, production profile, версія й update manifests не змінені.

- `task7-retirement-final-build.log`: повний clean-index build PASS, без
  diagnostic console patches. Packaged addon не експонує native test hooks.
- Full Desktop QA `run-1792757840217`: PASS, 53 result entries, негативні
  DASH/HLS/403 не блокують наступне відео; browser/native DASH, IPTV,
  AC3/EAC3, headers, tracks/subtitles, resume, offline/recovery і clean exit.
  Production profile metadata незмінена, process close 632 мс, код 0.
- Controls/layout `run-1792757978186`: 24 pause/seek/play, max round-trip
  22 мс; viewport 1280×720 і 960×640, справжній fullscreen 1920×1080 і
  повернення до windowed, `d3d11`/`d3d11va`, без media error. Screenshots
  переглянуті: правильне кадрування, непорожнє відео, без перекриття тексту.
- Orientation `run-1792758001587`: усі чотири кути й upright цифри PASS.
- Повторний GPU loss `run-1792758016200`: PASS, Canvas2D, позиція
  11.833 → 12.75 с, motion delta 4.01, pause/seek/play та clean exit.

SHA-256 фінальних компонентів:

| Component       | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------ |
| Launcher        | `985b3abf3b3dad056fecd9fca2a07a24f0c83574639ad2d3b8dcf8f4f5f7311e` |
| Native addon    | `57ebcd85525f3a1cc6801cfebdcb66664f1556e3db54612f6f0b653287cb8ddf` |
| MPV DLL         | `5371076ac7b2cc7ba92eda3dd16e2569e82ddf122204b18ad0c203eea467d0f1` |
| Main service JS | `e722aa72ffdf10b64d26a2c83a55c15feb59c9f1fe7625549a26b1368da7ddc7` |
| Renderer JS     | `d66f60e84f317c5e43be7606d6e67af240d47aff2f422d509c911bd7b4772654` |

Коренева копія звірена з clean-index build за hashes. Попередня збережена в
`.cache/mpv-desktop-d3d11-test/pre-final-candidate-win-unpacked-20261023/`.
Для відкату достатньо закрити тестову програму й запустити встановлену LampaUa.

Подальше оновлення JS/Electron перевикористовує перевірену DLL: rebuild addon
під ABI Electron, contracts, native/transport і Desktop QA. Зміна MPV/FFmpeg
або D3D11 patch вимагає окремого pinned-source/preflight/build/source-closure
циклу з новими hashes та notices; джерела поточного SDK не замінювати новішими
без такого циклу. Production runtime не підміняється candidate-файлами.

Ручний довгий реальний тест і автоматичні fixtures пройшли. Межі доказів:
покадрового заміру саме 80+ ГБ файла й повного фізичного scan-out усіх
відеокадрів немає. Успішні consumer cadence/pixel tests не називаються таким
доказом. Push, main merge, tag, release та зміна автооновлень не виконувалися.
