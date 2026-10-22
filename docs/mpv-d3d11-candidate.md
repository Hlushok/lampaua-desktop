# Кандидатна MPV D3D11 DLL

## Перший Запуск

21.10.2026 candidate-гілка `codex/mpv-d3d11-render` запушена без тегів.
Перший workflow: [39660081548](https://github.com/Hlushok/lampaua-desktop/actions/runs/39660081548),
точний build commit `ab78ed3487ac3b5eaec5d46289060d32386fbf4c`.

Збірка зупинилася на `Initialize containers`, до checkout, source-тестів та
компіляції: GHCR відповідає `manifest unknown` для pinned image
`sha256:2b81f07c567b051455b9539770a71b53dd3add5f9ef52eca95ac01a2272e9fdf`.
Пряма анонімна перевірка registry підтвердила HTTP 404. Повторення того самого
запуску без відновлення середовища не вирішить цю помилку.

Цей workflow не змінив реліз, автооновлення або встановлену програму.

## Відновлення Середовища 22.10.2026

Окремо погоджено змінити тільки контейнер candidate-збірки. Доступність exact
image перевірена через GHCR API (HTTP 200), платформа Linux amd64, created
16.10.2026. Новий digest:
`sha256:4a65616f389fa2a76955876a3e380284d3057cc04bfcac986008f20a710a0b76`.

Звичайний variant зберігає попередній container pin. MPV, FFmpeg, recipes,
Rust toolchain, target GCC та media dependency source locks не змінені.
Це не автоматична заміна образу на `latest`: workflow використовує точний digest.

Перед source-тестами та компіляцією candidate виконує
`scripts/mpv/preflight_environment.py`: перевіряє Linux amd64, Python >=3.12,
CMake >=3.31 із Ninja generator, Meson >=1.3, Ninja >=1.10 та потрібні команди.
Після цього реально конфігурує, компілює і запускає короткий C++20/thread/filesystem
тест. Помилка або timeout зупиняє pipeline до довгої збірки. Звіт
`.cache/libmpv-own-d3d11/environment.json` містить версії та зберігається у
діагностичному артефакті навіть після помилки. Жодні пакети контейнера при цьому
не оновлюються.

Запуск [39725003994](https://github.com/Hlushok/lampaua-desktop/actions/runs/39725003994)
успішно пройшов новий контейнер та реальний C++20 smoke test. Host tools:
Python 3.14.8, CMake 4.4.4, Ninja 1.13.2, Meson 1.12.1, GCC/G++ 16.2.1.
Одна baseline unit fixture успадкувала `LAMPAUA_MPV_VARIANT=d3d11`; коміт
`57e26c099a73494eff1f28fbe3c221025349cad4` явно ізолює її baseline-середовище,
не змінюючи production build або перевірку конфліктних pins.

## Відновлення Завантаження Джерел

Запуск [39725369962](https://github.com/Hlushok/lampaua-desktop/actions/runs/39725369962)
пройшов контейнер, environment gate і source-тести, але зупинився до компіляції:
`lib.openmpt.org:443` повернув `Connection refused` при завантаженні libopenmpt.
Це окрема мережева помилка, не помилка D3D11 backend.

Лише candidate inputs phase тепер попередньо завантажує libopenmpt 0.7.12:
спочатку original URL, потім [офіційне дзеркало OpenMPT](https://lib.openmpt.org/libopenmpt/download/)
на `ftp.gathering.org`. Резервний архів перевірений наживо 22.10.2026; SHA-256
`79ab3ce3672601e525b5cc944f026c80c03032f37d39caa84c8ca3fdd75e0c98`
точно збігається з незмінним source lock. Інший hash або pin відхиляється.
URL/hash оригіналу в recipe та source receipts не підміняються; фактичний
download URL записується окремо в `sources/downloads/libopenmpt.json`.
CMake повторно перевіряє архів у своєму `DOWNLOAD_DIR` перед розпакуванням.
Baseline, dependency versions та accepted DLL не змінені.

## Прийнятий Локальний Кандидат 22.10.2026

Збірка [39726751671](https://github.com/Hlushok/lampaua-desktop/actions/runs/39726751671)
успішно завершила компіляцію, source preflight та packaging. Точний build commit:
`530ed50499e4afeed19b8070f149dc5bb1818931`; пізніші documentation commits не
змінюють походження цієї DLL.

| Файл / Доказ       | SHA-256                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `libmpv-2.dll`     | `5371076ac7b2cc7ba92eda3dd16e2569e82ddf122204b18ad0c203eea467d0f1` |
| SDK archive        | `f8e2958cc3210d5ba833bb101c34b713fbf4202a1f3516b60d099db29a54303f` |
| Source archive     | `de0002968ad9ef5fb1bc59f3800a95789d68257f2dc6bde08901ecdcc9d18c10` |
| Effective MPV tree | `b6347890843a7ec5753d631ff1283be2770d2d980d91febe5f8c3cfa856f9e09` |

Повний downloaded CI ZIP перевірений за digest GitHub artifact
`12405854134`: `fbd70d47c63bcfe4c6676c8d2d518c46708bf9d7dc2adc8cc32d00bebb587b7f`.
Далі перевірені ZIP CRC, усі записи `checksums.json` та actual DLL/SDK/source
hashes. PE: x64, 54 exports `mpv_*`, ті самі 50 унікальних DLL dependencies,
що у прийнятого runtime, без нових зовнішніх бібліотек. Vulkan loader, як і
раніше, лишається залежністю Windows graphics environment.

Окремий test-addon зібраний проти саме цього SDK. П'ять hardware D3D11 context
cycles повернули API 131078, `hardware=true`, adapter LUID `0:1432c`,
`renderThread=true`. Повний verifier із перевіркою всього source archive мав
max main heartbeat gap 20.18 мс (<100 мс), після кожного циклу texture/handle/
thread counts повернулися до нуля. Старий API 2.5 відхилений у п'яти циклах.
GPU pool/resize/fault/lifecycle тести також пройшли. Default production-addon
без трьох test-only exports зібраний, чинний software lifecycle пройшов.

Source/notices audit перевірив 91 pinned input, 96 components, 827 notice files,
API/base/patch/effective-tree та bundled patch. Без окремо названих notice files
залишилися ті самі `build-recipes`, `nvcodec-headers`, `opus-dnn`, що й у baseline;
це не нова втрата атрибуції. Inventory збережений локально; його результат не
підміняє ліцензійні тексти всередині архівів.

Кандидат прийнятий для наступного етапу реалізації, не для релізу. Контекст ще
не відтворює відео через нову player factory; HEVC zero-copy, плавність, A/V sync
та повна LampaUa мають пройти Tasks 5-7. Installed Desktop, updater і
`build/libmpv-runtime.json` не змінені.

## Локальні Перевірки

- 81 source/package тест та структурна перевірка YAML workflow: PASS.
- Реальне fallback-завантаження з точним SHA-256 та CMake cached extraction: PASS.
- Підготовлений effective MPV archive та його tree hash перевірені повторно.
- Candidate SDK descriptor містить реальні hashes DLL, SDK і source archive.
- Test-only native context probe компілюється проти отриманого candidate SDK API 2.6.
- Реальні hardware D3D11 context cycles та source/notices audit: PASS.
- П'ять викликів із прийнятою DLL API 2.5 явно відхиляються, ресурси повертаються до нуля.
- Bounded GPU pool, resize, fault і cleanup тести нового test-addon: PASS.

Ці перевірки не є доказом плавності декодування або показу реального 4К-торента.

Локальні докази: `.cache/libmpv-d3d11-candidate/{artifacts,sdk,extracted,notices}/`,
`context-probe-sdk.json`, `dll-{dependents,headers,exports}.txt`;
журнали CI — `.cache/libmpv-d3d11-ci/39726751671/`. Прийнятий baseline SDK
залишається у власному попередньому каталозі.

## Перевірка Отриманого SDK

Зберігати downloaded artifact у `.cache/libmpv-d3d11-candidate/artifacts/`,
розпакований SDK — у `.cache/libmpv-d3d11-candidate/sdk/`. Прийнятий SDK не
перезаписувати. Точний build commit брати з успішного Actions run, не з рухомого
HEAD гілки. Descriptor `candidate-sdk.json` лежить поза архівами, щоб їхні hashes
не мали циклічного посилання на самих себе.

```text
node scripts/verify-mpv-d3d11-native.cjs --unit
node scripts/verify-mpv-d3d11-native.cjs --context-only --electron PATH --addon TEST_ADDON --sdk .cache/libmpv-d3d11-candidate/sdk --build-commit FULL_BUILD_SHA
python scripts/mpv/audit_runtime_sources.py --variant d3d11 --root . --sources SOURCES --manifest SDK_MANIFEST --output NEW_NOTICES_DIRECTORY
```

Другий запуск перевіряє descriptor, actual archive/DLL hashes, base/patch pins і
build revision до завантаження DLL, а потім п'ять разів створює та звільняє MPV
D3D11 context на окремому render thread. Потрібні client API 2.6, hardware device,
реальний adapter LUID, незаблокований main heartbeat і нуль витоків. Старий API
перевіряється окремо через `--expect-api-rejection` з `--sdk` старого SDK.

До прийняття також потрібні перевірка PE imports та source/notices closure,
після цього — інтеграція й реальні 4К-тести повного Desktop. Наявність header,
успішний linker або metadata fixture самі по собі не дають acceptance.
