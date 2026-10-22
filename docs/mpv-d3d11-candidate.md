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

Нова DLL ще має пройти компіляцію та runtime-приймання. Успішні локальні тести
не підміняють ці перевірки.

## Локальні Перевірки

- 81 source/package тест та структурна перевірка YAML workflow: PASS.
- Реальне fallback-завантаження з точним SHA-256 та CMake cached extraction: PASS.
- Підготовлений effective MPV archive та його tree hash перевірені повторно.
- Candidate SDK descriptor містить реальні hashes DLL, SDK і source archive.
- Test-only native context probe компілюється проти exact patched API 2.6 headers.
- П'ять викликів із прийнятою DLL API 2.5 явно відхиляються, ресурси повертаються до нуля.
- Bounded GPU pool, resize, fault і cleanup тести нового test-addon: PASS.

Останні два пункти не є доказом працездатності нового D3D11 backend: для цього
потрібна нова зібрана DLL та успішне створення реального hardware context.

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
