# Кандидатна MPV D3D11 DLL

## Поточний Стан

21.10.2026 candidate-гілка `codex/mpv-d3d11-render` запушена без тегів.
Перший workflow: [39660081548](https://github.com/Hlushok/lampaua-desktop/actions/runs/39660081548),
точний build commit `ab78ed3487ac3b5eaec5d46289060d32386fbf4c`.

Збірка зупинилася на `Initialize containers`, до checkout, source-тестів та
компіляції: GHCR відповідає `manifest unknown` для pinned image
`sha256:2b81f07c567b051455b9539770a71b53dd3add5f9ef52eca95ac01a2272e9fdf`.
Пряма анонімна перевірка registry підтвердила HTTP 404. Повторення того самого
запуску без відновлення середовища не вирішить цю помилку.

Контейнер, pins MPV/FFmpeg та залежностей поки не змінені. Нової DLL ще немає;
цей workflow не змінив реліз, автооновлення або встановлену програму.

## Локальні Перевірки

- 60 source/package тестів та структурна перевірка YAML workflow: PASS.
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
```

Другий запуск перевіряє descriptor, actual archive/DLL hashes, base/patch pins і
build revision до завантаження DLL, а потім п'ять разів створює та звільняє MPV
D3D11 context на окремому render thread. Потрібні client API 2.6, hardware device,
реальний adapter LUID, незаблокований main heartbeat і нуль витоків. Старий API
перевіряється окремо через `--expect-api-rejection` з `--sdk` старого SDK.

До прийняття також потрібні перевірка PE imports та source/notices closure,
після цього — інтеграція й реальні 4К-тести повного Desktop. Наявність header,
успішний linker або metadata fixture самі по собі не дають acceptance.
