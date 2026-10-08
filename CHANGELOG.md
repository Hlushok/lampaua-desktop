# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [2.0.0](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.24...v2.0.0) (2026-10-08)

### Нова Серія 2.x

- 2.0.0 відкриває нову основну серію через зміну архітектури вбудованого відтворення; 1.5.24 є останнім релізом серії 1.x, включно зі звичайною та експериментальною AC3/EAC3-збірками.
- Windows x64 використовує саме рушій і виправлення локальної тестової `1.5.24-mpv.6`, а не повертається до попереднього браузерного плеєра для всіх джерел.

### Що Додано І Що Це Дає

- Вбудовано libmpv через адаптований `yscoder/electron-mpv-video`: відтворення залишається у вікні Lampa з її керуванням, без обов'язкового запуску окремого плеєра.
- Розширено підтримку контейнерів і кодеків у Windows x64. На локальних контрольних файлах перевірені, зокрема, AVI/Xvid, AC3 та EAC3; це не гарантія відтворення будь-якого файла або потоку.
- Збережено Electron 44.4.4 AC3/EAC3 від `ARST113/electron`, використаний у протестованій збірці; версії, джерела й контрольні суми runtime зафіксовані.
- Підключено паузу, перемотування, гучність, швидкість, звукові доріжки, субтитри та позицію перегляду до керування Lampa.

### Сумісність І Виправлення

- YouTube через чинний yt-dlp-модуль використовує його браузерний DASH-шлях; якість не примусово знижена до 360p. Реальні 720p, 1080p і коротке 4K-відтворення перевірені локально; тривале 4K та перемотування кожного реального потоку не гарантуються.
- Виправлено розпізнавання HLS у підписаних IPTV-посиланнях без розширення. Перевірені Arena Sport 1 HD і Nova Sport 1 HD.
- Підтримано потрібні HTTP-заголовки захищених потоків, збережено ізоляцію сеансів, очищення плеєра при перемиканні та обмеження мережевих протоколів.
- Lampac, серверні модулі YouTube/IPTV/SISI та сервер не змінювалися цим релізом.

### Оновлення Та Збереження Налаштувань

- Робочий Windows x64-пакет має звичні назву LampaUa, appId та профіль. Оновлення зі звичайної або AC3/EAC3-версії 1.5.24 не переносить і не підміняє налаштування окремого тестового профілю.
- Збережені вибір зовнішнього плеєра, адреси HTTPS/HTTP, налаштування TorrServer та інтеграція UA Player; нові значення за замовчуванням не перезаписують збережений вибір.
- Автооновлення робочої програми використовує власний GitHub-канал LampaUa; тестові portable залишаються ізольованими й без автооновлення.
- MPV у цьому релізі призначений лише для Windows x64. Windows ARM64/32-bit, Linux і macOS залишаються на браузерному рушії; переносити на них результати MPV-тестів не можна.
- За погодженням власника реліз 2.x оформлено як GPL-3.0-or-later зі збереженням авторства та сторонніх ліцензій. Публічне поширення бібліотек потребує завершеного комплекту відповідних вихідних текстів.

## [1.5.24](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.23...v1.5.24) (2026-10-08)

### Вбудований плеєр

- увімкнено `AudioVideoTracks` для перемикання вбудованих звукових доріжок у Lampa;
- додано окрему експериментальну Windows x64-збірку `lampaua-x64-1.5.24-ac3.exe` з кастомним Electron `44.4.4`, зібраним із підтримкою AC3/EAC3;
- версія runtime та контрольні суми архіву й `ffmpeg.dll` закріплені й перевіряються під час підготовки;
- runtime перевіряється повторно всередині пакета до створення експериментального інсталятора; файли цієї збірки мають окремий каталог і не змінюють стандартний файл автооновлення;
- звичайні інсталятори й автооновлення залишаються на офіційному Electron; експериментальний файл встановлюється вручну. Його чинне автооновлення також використовує звичайний канал і може замінити кастомний runtime у наступному релізі;
- підтримка AC3/EAC3 через Lampa та TorrServer ще потребує перевірки реального відео зі звуком; AVI не підтримується цим підходом, для нього слід обирати зовнішній плеєр.

## [1.5.23](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.22...v1.5.23) (2026-10-07)

### ♻️ Рефакторинг

- изменить блок с информацией о TorrServer ([116e4fa](https://github.com/Hlushok/lampaua-desktop/commit/116e4fa35816765cce6988fcdda171c0536ca047))
- сделать управление геймпадом, если только окно в фокусе ([653cb7b](https://github.com/Hlushok/lampaua-desktop/commit/653cb7b4f006ce78196da7b6aa11f959d36fad78))

## [1.5.22](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.21...v1.5.22) (2026-10-05)

### 🐛 Исправления

- preserve provider reserve URL in UA Player handoff ([5310894](https://github.com/Hlushok/lampaua-desktop/commit/53108946931fa8a69448cc99eaf5d7b0c9b21665))

## [1.5.21](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.20...v1.5.21) (2026-09-30)

### Linux

- виправлено категорію AppImage на стандартну `AudioVideo`, щоб каталог AppImageHub прийняв ярлик застосунку.

## [1.5.20](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.19...v1.5.20) (2026-09-27)

### 🔌 Інтеграція UA Player

- збільшено ліміти передавання IPTV-плейлистів до 20 000 каналів і 16 MiB зі збереженням вибраного каналу;
- логотипи каналів передаються до UA Player як зображення елементів плейлиста;
- додано перевірки великих списків і граничного розміру відповіді плеєра.
- підготовлено приймання проміжних таймкодів від сумісної версії UA Player без закриття сеансу: збереження позицій окремих серій, підтримка перемотування назад і до початку;
- захищений сеанс продовжує очікувати результат після переадресації запуску в уже відкритий плеєр; старі версії UA Player, як і раніше, повертають таймкод лише при завершенні;
- нова проміжна синхронізація потребує відповідного оновлення UA Player; саме оновлення Desktop не вмикає її у старому плеєрі.

### 🔧 Синхронізація та сумісність

- усунуто конфлікт автоматичної синхронізації з upstream зі збереженням опису, брендингу й налаштувань LampaUa;
- інтегровано підтримку запуску SenPlayer з upstream;
- піднято версію для розповсюдження цих змін через стандартне автооновлення.

## [1.5.19](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.16...v1.5.19) (2026-09-25)

### 🔌 Інтеграція UA Player

- адаптер запускає UA Player після остаточного вибору зовнішнього потоку в LampaUa, не втрачаючи дані через передчасне створення сеансу;
- до захищеного сеансу передаються доступні LampaUa метадані IPTV, плейлист, таймкод, доріжки, субтитри, якості та сегменти пропуску;
- оновлено пошук і вибір установленого UA Player та українські повідомлення про результат вибору.

### 🔧 Оновлення

- Windows-реліз публікує `latest.yml` разом із відповідними NSIS-інсталяторами та файлами `.blockmap` для автооновлення.

## [1.5.16](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.15...v1.5.16) (2026-08-31)

### ✨ Новые возможности

- добавить скрипт генерирования иконок приложения ([6c74f0f](https://github.com/Hlushok/lampaua-desktop/commit/6c74f0fde03295dd2259f5e5196cc8a364bfb754))
- обновить иконки приложения и скрипт генерации ([fcf2c52](https://github.com/Hlushok/lampaua-desktop/commit/fcf2c5266d06e2b65f449e5fca40065d0a61a60b))

### 🐛 Исправления

- исправить закругления для Linux и Windows ([dca9d13](https://github.com/Hlushok/lampaua-desktop/commit/dca9d134c7948be179f811e3b8e6fb7c78b7055a))

### ♻️ Рефакторинг

- изменить условия определения работы GST ([9e0aa7f](https://github.com/Hlushok/lampaua-desktop/commit/9e0aa7faad9719c166ff359fe9aebc93a44f0c7b))

## [1.5.15](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.14...v1.5.15) (2026-08-29)

### ✨ Новые возможности

- додано UA Player for Windows як повноцінний зовнішній плеєр із точним пошуком у Program Files
  та сумісністю з попереднім шляхом встановлення;
- додано bounded session/result JSON для плейлистів, метаданих і повернення прогресу окремо для
  кожного стабільно відтвореного елемента;
- додано безпечний fallback TorrServer URL із `preload` на звичайний запуск відтворення.

### 🐛 Исправления

- збережено чинний owner-bound child-process contract під час запуску UA Player;
- шлях зовнішнього плеєра тепер авторизується лише main-процесом після системного вибору файлу;
- заблоковано object, array, escaped, dotted і bracket обходи захищених ключів налаштувань;
- result-файл читається атомарно, перевіряється за схемою та гарантовано очищається після сеансу.

## [1.5.14](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.13...v1.5.14) (2026-08-25)

## [1.5.13](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.12...v1.5.13) (2026-08-25)

### ✨ Новые возможности

- добавить поддержку TorrServer GST ([f4a9a99](https://github.com/Hlushok/lampaua-desktop/commit/f4a9a99c9af5cd416061217423a6db6fd30c8397))

### 🐛 Исправления

- support killing proxied player processes ([5455846](https://github.com/Hlushok/lampaua-desktop/commit/54558463174b6698b4239299a694a194a5684daa))

## [1.5.12](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.11...v1.5.12) (2026-08-20)

### ✨ Новые возможности

- добавить локализацию настроек клавиатуры ([2fc288e](https://github.com/Hlushok/lampaua-desktop/commit/2fc288e905b26403975c508d1ff8c44a8d2eecde))
- добавить управление с геймпада ([a0802ab](https://github.com/Hlushok/lampaua-desktop/commit/a0802ab1889e8dca4163279996dac90e65ba08bc))
- улучшить работу геймпада с экранной клавиатурой ([df77a54](https://github.com/Hlushok/lampaua-desktop/commit/df77a54910531bd1ce496ad2a181f3a42d3cfba8))

### 🐛 Исправления

- исправить инициализацию настроек клавиатуры ([bc58fd5](https://github.com/Hlushok/lampaua-desktop/commit/bc58fd52a04d05782a8764af3bb0858d151161e8))
- исправить управление геймпадом в полях ввода ([6950608](https://github.com/Hlushok/lampaua-desktop/commit/695060888cbf8ef15b16c9f24755ad4f776fd2b6))

## [1.5.11](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.10...v1.5.11) (2026-08-11)

## [1.5.10](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.9...v1.5.10) (2026-07-11)

### ✨ Новые возможности

- restrict LampaUa URL choices ([b48b391](https://github.com/Hlushok/lampaua-desktop/commit/b48b3916d5f2c88c194a9f87a3bf8420cdae0d04))

## [1.5.9](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.8...v1.5.9) (2026-07-03)

### 🔧 CI/CD

- ignore major action updates ([d2b0dc5](https://github.com/Hlushok/lampaua-desktop/commit/d2b0dc52b3d9a48c254501438af318592de9419a))

## [1.5.8](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.7...v1.5.8) (2026-07-01)

### 🔧 CI/CD

- add dependency update checks ([8bc5dbd](https://github.com/Hlushok/lampaua-desktop/commit/8bc5dbdbdd85d0616495609fc9dce4e8e2888fe6))

## [1.5.7](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.6...v1.5.7) (2026-06-28)

### 🔧 CI/CD

- update release action to Node 24 ([dcc4e58](https://github.com/Hlushok/lampaua-desktop/commit/dcc4e58201f903080bd8289cd86aa1d2ab9aba2b))

## [1.5.6](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.5...v1.5.6) (2026-06-15)

## [1.5.5](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.4...v1.5.5) (2026-06-06)

### 📚 Документация

- обновить документацию ([0059e9d](https://github.com/Hlushok/lampaua-desktop/commit/0059e9d0801a0f5cd95a02ba416fe28c8f69161d))

### 🔧 CI/CD

- исправить проблемы отсутсивя ссылок на файлы для скачивания ([2e412f2](https://github.com/Hlushok/lampaua-desktop/commit/2e412f2b7739da7deeca4e077425ac6d8660b69f))
- исправить проблемы отсутсивя ссылок на файлы для скачивания ([561546a](https://github.com/Hlushok/lampaua-desktop/commit/561546ac4a8d6af754e34e280a701c2f49646702))

## [1.5.4](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.3...v1.5.4) (2026-06-04)

### 🐛 Исправления

- исправить поиск плеера на MacOS ([825b266](https://github.com/Hlushok/lampaua-desktop/commit/825b2666b518a3e42790cc7a1dd8b6f1b5df7b85))

### 📚 Документация

- обновить документацию ([1a8a474](https://github.com/Hlushok/lampaua-desktop/commit/1a8a474a201b881f165fe07b1ede12713540647d))
- обновить документацию ([2fb2462](https://github.com/Hlushok/lampaua-desktop/commit/2fb24623259d71d67fcfd6732880f55fe0214250))

### ♻️ Рефакторинг

- добавлена поддержка KMPlayer ([6ba23bf](https://github.com/Hlushok/lampaua-desktop/commit/6ba23bf0e3471abddfe5de5b552ba95a82030f16))

## [1.5.3](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.2...v1.5.3) (2026-06-02)

### ♻️ Рефакторинг

- добавить плеер MPC-QT ([0fd2ca5](https://github.com/Hlushok/lampaua-desktop/commit/0fd2ca552b13cf741b7cc1f28810949f40912eb7))
- изменить режимы работы полного экрана ([c430223](https://github.com/Hlushok/lampaua-desktop/commit/c430223242b0a1404342d411019d418bf5873bb6))
- **plugin:** изменить стили окна пожертвования ([9822983](https://github.com/Hlushok/lampaua-desktop/commit/9822983e10bf5a88ecfdc91fb073645170a24230))

### 📦 Сборка

- изменена версия yarn на 4.9.4 ([2e1c55f](https://github.com/Hlushok/lampaua-desktop/commit/2e1c55f6e1c41a575d59a77b43ea6ce1e2bdede8))

## [1.5.2](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.1...v1.5.2) (2026-05-17)

## [1.5.1](https://github.com/Hlushok/lampaua-desktop/compare/v1.5.0...v1.5.1) (2026-05-16)

### Зміни

- Адаптовано застосунок під LampaUa: назва, `appId`, артефакти збірки та GitHub releases.
- Оновлено стартову адресу та резервний endpoint Lampac для LampaUa.
- Виправлено пакування Windows-іконки.
- Уточнено українські тексти імпорту та експорту.
- Виправлено Prettier-перевірки для Windows checkout.
- Очищено таблицю завантажень у GitHub Release для окремих Windows, macOS і Linux файлів.

## [1.5.0](https://github.com/Kolovatoff/lampa-desktop/compare/v1.4.0...v1.5.0) (2026-05-05)

### ✨ Новые возможности

- добавлена поддержка mpc-hc и mpc-be плееров и поиск/выбор плеера в настройках([3f3a83a](https://github.com/Kolovatoff/lampa-desktop/commit/3f3a83a9f51717c8fa2e002e9b65a56e20a35bb9))

### ♻️ Рефакторинг

- убрано упоминание vlc в OptionsInterceptor ([8472ba1](https://github.com/Kolovatoff/lampa-desktop/commit/8472ba138ee813dd82ddd5af236ffb4d8b6b8171))
- **export-import:** добавлен перевод на несколько языков ([e66d1c0](https://github.com/Kolovatoff/lampa-desktop/commit/e66d1c0b514e74daf65e280bad2f7ce8cdb52478))
- **plugin:** удален removeMic после [#318](https://github.com/Kolovatoff/lampa-desktop/issues/318) в yumata/lampa-source ([c86e8f4](https://github.com/Kolovatoff/lampa-desktop/commit/c86e8f466126626c5f1f24dc171b89b05a4788c0))

## [1.4.0](https://github.com/Kolovatoff/lampa-desktop/compare/v1.3.1...v1.4.0) (2026-04-10)

### ✨ Новые возможности

- добавлена возможность включать и отключать CORS (актуально для балансеров) ([0428008](https://github.com/Kolovatoff/lampa-desktop/commit/0428008d455443fc5940d40b2cce84ff83c581b9))

### 🐛 Исправления

- поиск теперь не открывается по кнопке S, если открыто модальное окно ([e38fa37](https://github.com/Kolovatoff/lampa-desktop/commit/e38fa37b31aaf319272c5f7b29563112249febe4))

### ♻️ Рефакторинг

- удален http-proxy для vlc и заменен подменой OPTIONS ответа ([4fef3c3](https://github.com/Kolovatoff/lampa-desktop/commit/4fef3c38577717f6a0ec6f3031e691aa167362b3))

## [1.3.1](https://github.com/Kolovatoff/lampa-desktop/compare/v1.3.0...v1.3.1) (2026-03-23)

### 🐛 Исправления

- исправить параметр webSecurity ([737f0a7](https://github.com/Kolovatoff/lampa-desktop/commit/737f0a7ae1139c1f92697ad9d6bd28f3d93912b1))
- **Handlers:** вернуть потерянный get-app-version ([c17c98c](https://github.com/Kolovatoff/lampa-desktop/commit/c17c98c6fdbc0024ddfd0eb13de640b3f5a61293))

### 📚 Документация

- **README:** исправление ссылки на документацию ([07b069a](https://github.com/Kolovatoff/lampa-desktop/commit/07b069a08d11c465fd2532dc7419794bf400af15))

### ♻️ Рефакторинг

- горячая клавиша M открывает/закрывает меню ([14c0741](https://github.com/Kolovatoff/lampa-desktop/commit/14c0741a217a83173552201abeb3fd6b9c4ec1d2))
- добавить кнопку "Список изменений на GitHub" ([0fa07fb](https://github.com/Kolovatoff/lampa-desktop/commit/0fa07fb6f6acbc761163793fe469e39f2bdaa9e1))
- добавить поиск плеера кнопкой в настройках ([ee7782d](https://github.com/Kolovatoff/lampa-desktop/commit/ee7782d949d00b049377dd9f5c5f315af2431295))
- изменить переопределение кнопки fullscreen ([e813f38](https://github.com/Kolovatoff/lampa-desktop/commit/e813f38d2453c0ab6ec42a04a3e45d9bbc816f7a))
- отменить поиск плеера если выбран внутренний плеер ([2b7b924](https://github.com/Kolovatoff/lampa-desktop/commit/2b7b924f4760243683885731dab593424daf9a63))
- переименовать Настройки приложения в Приложение ([683e7f5](https://github.com/Kolovatoff/lampa-desktop/commit/683e7f598fbd526d35ae199ed3b12b5c0881a79f))

## [1.3.0](https://github.com/Kolovatoff/lampa-desktop/compare/v1.2.1...v1.3.0) (2026-03-09)

### ✨ Новые возможности

- добавлен inputManager для управления горячими клавишами и курсором ([3aa6b16](https://github.com/Kolovatoff/lampa-desktop/commit/3aa6b16902e2934b3187df63a2f9017c16b8c872))
- удаление микрофона на формах ввода ([6baf960](https://github.com/Kolovatoff/lampa-desktop/commit/6baf96007c8e1632057cdf6b617edb7b945c3eff))

### 🐛 Исправления

- исправления под MacOS ([a3a29a1](https://github.com/Kolovatoff/lampa-desktop/commit/a3a29a1e10309e84e153073a59280e1f2031d8ba))
- отключение горячей клавиши полноэкранного режима при вводе ([dd0790a](https://github.com/Kolovatoff/lampa-desktop/commit/dd0790a2d4a8f94fcf51431b2958d45e94fd430f))

### 📚 Документация

- добавлена ссылка на документацию от ИИ ([bcbeb8a](https://github.com/Kolovatoff/lampa-desktop/commit/bcbeb8aa9e9203cc79c596a615400d29fd50c6f6))
- обновление бейджа скачиваний, без учета файлов обновлений ([e6eb174](https://github.com/Kolovatoff/lampa-desktop/commit/e6eb174122fa19ce2586f8b0a3e7fa820f4d7d52))
- обновление README.md ([0020d48](https://github.com/Kolovatoff/lampa-desktop/commit/0020d48ffb9102de0e572c3ed9a8a7514e819ef3))

### ♻️ Рефакторинг

- базовая защита spawn ([370ee48](https://github.com/Kolovatoff/lampa-desktop/commit/370ee481cb5f028527a9ea83382467f921050bbb))
- добавлена кнопка открытия веб-интерфейса torrserver ([3e99de0](https://github.com/Kolovatoff/lampa-desktop/commit/3e99de0b1e438dd3fb25c4980db054912f651906))
- частичный перевод приложения ([f821927](https://github.com/Kolovatoff/lampa-desktop/commit/f821927b5898451345c6300ce7229bdfae26ac92))

### 📦 Сборка

- добавление rpm для linux ([651407b](https://github.com/Kolovatoff/lampa-desktop/commit/651407ba13765acb9412e472ce352ba8f27688ea))
- добавление rpm пакетов ([f11bad6](https://github.com/Kolovatoff/lampa-desktop/commit/f11bad6196855e0877595d78a6fb2eb4ee26b7b5))

## [1.2.1](https://github.com/Kolovatoff/lampa-desktop/compare/v1.2.0...v1.2.1) (2026-02-19)

### 🐛 Исправления

- при изменении параметров ts, меню убегало вверх ([8aae410](https://github.com/Kolovatoff/lampa-desktop/commit/8aae410db69486558e869ce200d4c4d34509a1a4))

### 📚 Документация

- обновление README.md ([efac48b](https://github.com/Kolovatoff/lampa-desktop/commit/efac48b53a8d3a39c5e0ceee4ddf98144e488b2b))

### ♻️ Рефакторинг

- убрано указание localhost у TS. Т.к. ts не запускается на ipv6 при указании localhost ([2ea2e59](https://github.com/Kolovatoff/lampa-desktop/commit/2ea2e59f4a9cafb14bbb5333cf12b3c6070f462a))

## [1.2.0](https://github.com/Kolovatoff/lampa-desktop/compare/v1.1.1...v1.2.0) (2026-02-18)

### ✨ Новые возможности

- встроенный torrserver ([47c73bf](https://github.com/Kolovatoff/lampa-desktop/commit/47c73bfd116dcffa7399755a525db28330f13c2f))
- модуль инициализации хранилища лампы ([95bfd45](https://github.com/Kolovatoff/lampa-desktop/commit/95bfd45e98e50f3ae7eba6e0b374f46bb4e20f8e))
- модуль поиска установленного VLC ([57bb036](https://github.com/Kolovatoff/lampa-desktop/commit/57bb0365c69f4c1c33e1ab20b3dbf54a848dd145))
- модуль работы с папками и открытие TS папки ([f6e1c3e](https://github.com/Kolovatoff/lampa-desktop/commit/f6e1c3e6c2b0708e6f3241487c5810f03ba43f1d))

### 📚 Документация

- изменена инструкция export-import.md ([23fd66b](https://github.com/Kolovatoff/lampa-desktop/commit/23fd66bc16ffd82e500cbad6310c86f4cf808f02))
- обновление документации по экспорту/импорту ([dd72ee8](https://github.com/Kolovatoff/lampa-desktop/commit/dd72ee8123065a6d55f3faf3a6745d2f42739617))
- обновление README.md ([081d5d8](https://github.com/Kolovatoff/lampa-desktop/commit/081d5d8e8f5856bb7c7cd62fe34b5e26f581a106))

### ♻️ Рефакторинг

- добавление ссылки на ts по-умолчанию localhost ([d858ba7](https://github.com/Kolovatoff/lampa-desktop/commit/d858ba7221e3da2698b46b717c78fb3f6c4e16b9))
- изменение структуры приложения ([6e3cc84](https://github.com/Kolovatoff/lampa-desktop/commit/6e3cc8466f0be381f6fe42fb2c8330b69dede0a4))
- обновление плагина экспорт/импорт ([75410a0](https://github.com/Kolovatoff/lampa-desktop/commit/75410a050100cf2b9e274139ec8e081516748941))

## [1.1.1](https://github.com/Kolovatoff/lampa-desktop/compare/v1.1.0...v1.1.1) (2026-02-11)

### 🐛 Исправления

- исправление отображения иконки на linux ([d7e8c1c](https://github.com/Kolovatoff/lampa-desktop/commit/d7e8c1c2c300d51eaf25069ac7eebeb1a9d5742b))
- исправление ошибки создания окна при изменении DisplayID ([190211e](https://github.com/Kolovatoff/lampa-desktop/commit/190211e24cdd4a41d621f8ee20265c7798499aed))

### ♻️ Рефакторинг

- изменены иконки ([a4154c6](https://github.com/Kolovatoff/lampa-desktop/commit/a4154c6cadd5ee394b263dbd7e9209fb78ca8875))
- убраны icon из createWindow ([f2dce8e](https://github.com/Kolovatoff/lampa-desktop/commit/f2dce8e262bd7b747528ddf05d3d1743e58c30e3))
- улучшенная проверка на запуск одного экземпляра приложения и доп проверки остановки веб для vlc ([4f58b13](https://github.com/Kolovatoff/lampa-desktop/commit/4f58b13eb25832767248c75e687b961d0785604b))

### 🔧 CI/CD

- исправление скрипта получения changelog ([e0a0c03](https://github.com/Kolovatoff/lampa-desktop/commit/e0a0c033c5676991c1658a5c76abadb1af2158b4))

## [1.1.0](https://github.com/Kolovatoff/lampa-desktop/compare/v1.0.0...v1.1.0) (2026-02-04)

### ✨ Новые возможности

- автообновления ([422eea7](https://github.com/Kolovatoff/lampa-desktop/commit/422eea7dfc3b9d4369a8b740448b05ddd44681e9))
- возможность экспорта и импорта настроек ([947fe7f](https://github.com/Kolovatoff/lampa-desktop/commit/947fe7f58ef9ec018b1aa9e88590bc79216770bd))
- добавлен плагин для экспорта настроек из другого приложения лампы на electron или nw ([5846792](https://github.com/Kolovatoff/lampa-desktop/commit/5846792958aeea11fd1f475d30660305e523b604))
- добавлены настройки приложения ([723fc3b](https://github.com/Kolovatoff/lampa-desktop/commit/723fc3b08571f10a1bf5ef9bf83c95c519148b31))
- обработка ошибочного ввода URL лампы ([0cc8a6c](https://github.com/Kolovatoff/lampa-desktop/commit/0cc8a6c46770a8ce08164dd1cd447f4e6cfe9097))
- сохранение позиции окна и дисплея ([62e54ec](https://github.com/Kolovatoff/lampa-desktop/commit/62e54ec3b6a784c83b4558043a1068f804eab02e))

### 🐛 Исправления

- исправлено получение версии в "О приложении" ([d32c4d4](https://github.com/Kolovatoff/lampa-desktop/commit/d32c4d4b624c7a191bc2d0307f6f5ea77a9cf264))
- решение проблемы с нерабочим window.location.reload ([6433b03](https://github.com/Kolovatoff/lampa-desktop/commit/6433b03d5507c46232750b725280ca9bc51941b3))
- **plugins:** фикс шаблона настроек ([dea8951](https://github.com/Kolovatoff/lampa-desktop/commit/dea895118399727678c06a4a927b0d8dbe47b5b2))

### 📚 Документация

- добавлена документация по переносу настроек ([c09e312](https://github.com/Kolovatoff/lampa-desktop/commit/c09e312af7416e8442e7404b1628c11018bb4087))
- изменение ссылок в содержании ([468d02e](https://github.com/Kolovatoff/lampa-desktop/commit/468d02ed8558e199a01889958460587d3a1fba2b))

### 📦 Сборка

- добавлено в сборку deb для linux ([ccf8776](https://github.com/Kolovatoff/lampa-desktop/commit/ccf8776697a4ae2f14f8f29d2a084fcece2efd63))

### 🔧 CI/CD

- добавлено deb для linux ([fe581f4](https://github.com/Kolovatoff/lampa-desktop/commit/fe581f42980e5374fedadd0abff7178ee59621b9))

## 1.0.0 (2026-01-27)

### 🐛 Исправления

- изменены иконки для приложений ([fc7d3d3](https://github.com/Kolovatoff/lampa-desktop/commit/fc7d3d3cc42ef145abbb3fc81bc2d1337677b5ce))
- исправление forge.config.js ([7038db3](https://github.com/Kolovatoff/lampa-desktop/commit/7038db305ec479774e383c470a5b2417daf89552))

### 📦 Сборка

- изменен способ сборки приложения ([0c8e861](https://github.com/Kolovatoff/lampa-desktop/commit/0c8e86131f5567ee69243bb2abce7f139029e698))
- изменение версии приложения ([cc45885](https://github.com/Kolovatoff/lampa-desktop/commit/cc45885f92f3125147aeec1c18f187c3800d1bc0))
- изменение workflows на запуск по тегу, а не пушу в main ([8915ab4](https://github.com/Kolovatoff/lampa-desktop/commit/8915ab48b679872525d1717381091fff4cf0ea90))

### 🔧 CI/CD

- изменен npm на yarn ([744b0e5](https://github.com/Kolovatoff/lampa-desktop/commit/744b0e52ebefb000dfee841423df6ae8f2923e6e))
