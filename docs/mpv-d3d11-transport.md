# Перевірка D3D11 Transport

## Межі Етапу

Локальна перевірка від 21.10.2026: Electron 45.0.0, Windows x64, Intel Gen 9,
hardware D3D11/WebGPU, adapter LUID `0:1432c`. Це передача синтетичних GPU-кадрів
без MPV-декодування, аудіо або Lampa. Вікно 641x362 CSS, DPR 1.25; вихідна
текстура 801x453, а не 3840x2160. Цей результат не закриває дефект 4К-торента.

## Результати

| Перевірка                                 | Результат                                                |
| ----------------------------------------- | -------------------------------------------------------- |
| 24 FPS, 60 с                              | 1440/1440 унікальних правильних GPU-маркерів             |
| 60 FPS, 60 с                              | 3599/3600; один пропуск producer, у межах одного за 30 с |
| Canvas/pipeline drops                     | 0/0 в обох 30-секундних вікнах обох запусків             |
| Compositor FPS, 24                        | 24.000 / 24.033                                          |
| Compositor FPS, 60                        | 60.033 / 60.033                                          |
| Clock ratio, 24                           | 1.00060 / 0.99976                                        |
| Clock ratio, 60                           | 0.99975 / 0.99921                                        |
| UI RAF / idle baseline                    | 0.996 / 0.987                                            |
| IPC після GPU-передач, 10 с               | 96 / 94 відповідей                                       |
| 50 create/resize/close + помилка callback | PASS; точні leases звільнені по одному разу              |
| Ресурси після закриття                    | 0 текстур, 0 дескрипторів, 0 render-потоків              |
| Production-addon                          | Зібраний без тестової фабрики та лічильників             |
| Чинний software lifecycle                 | PASS                                                     |

Докази у `.cache/libmpv-d3d11-transport-evidence/`:

- `1792608828794-24fps`: `evidence.json`, screenshots, повний gzip trace та його вибірка.
- `1792608937169-60fps`: ті самі матеріали для 60 FPS.
- `1792609101945-50cycles`: окремі статистики та release keys кожного циклу.

Публічний CDP trace містить зворотний зв'язок compositor про показ кадрів, а не
вимірювання фізичного scanout. Окремий test-only WebGPU readback перевіряє
sequence у пікселях; callback або IPC ACK сам по собі не вважається показом.
`report_swap` за цими сигналами не викликається.

## Методика І Відмови

Два незалежні 30-секундні вікна мають виконати початкові пороги плану: щонайменше
98% унікальних кадрів, не більш як один пропуск, clock ratio 0.98–1.02, UI RAF
щонайменше 90% baseline. Немає помилкових sequence, перестановки або missing content.

Тест читає trace лише після вимірювання через публічний `ReturnAsStream`.
Потік обмежений за розміром; data loss, невідома схема або неповне покриття не
дають PASS. Додаткові 6 с до/після вимірювання потрібні для завершених блоків
`CanvasAnimation`; незавершений хвіст не є доказом. Весь виміряний інтервал
повинен мати щонайменше 98% покриття завершеними блоками.

Попередні невдалі вимірювання залишені в кеші. Безперервний `capturePage`
заважає вимірюванню 60 FPS; live `ReportEvents` також додає навантаження в main.
24-FPS run `1792608664136` мав 8 Canvas drops і не пройшов gate. Пороги після
цього не знижувалися. `--capture-poll` залишений лише як діагностика.

Нативне очікування GPU-події використовує `IDXGIDevice2::EnqueueSetEvent` на
render thread; це не presentation event. Попередній `Sleep(1)` фактично додавав
крок Windows-таймера близько 15 мс. Пул має три слоти й максимум одне retired
покоління, шість GPU-leases загалом. Таймаут, crash renderer або невдалий native
release не дають права повторно використати текстуру: ресурс залишається в
обмеженому карантині. Після втраченої GPU-відповіді повторне увімкнення GPU може
потребувати перезапуску процесу. UI disposal не очікує його синхронно.

Unit-перевірки охоплюють foreign/iframe ACK, неготового owner, знищений frame,
точні generation/slot/sequence, дублікати ACK/GPU callback, старі кадри,
невідповідний sync token, загальний ліміт шести leases, callback failure,
native release failure та помилку самого error reporter.

## Повторення

```text
node scripts/verify-mpv-d3d11-transport.cjs --unit
node scripts/verify-mpv-d3d11-transport.cjs --electron PATH --addon TEST_ADDON --seconds 60 --fps 24
node scripts/verify-mpv-d3d11-transport.cjs --electron PATH --addon TEST_ADDON --seconds 60 --fps 60
node scripts/verify-mpv-d3d11-transport.cjs --electron PATH --addon TEST_ADDON --cycles 50
node scripts/verify-mpv-d3d11-pool.cjs --electron PATH --addon TEST_ADDON
```

Тестова фабрика компілюється тільки з `--lampaua_gpu_test=1`. Видимі тестові
вікна мають окремий кеш-профіль; встановлену програму не запускаємо і не міняємо.
Performance-запуски виконуються послідовно, без паралельних плеєрів і збірок.

## Наступний Етап

Погоджені candidate push/CI і Task 4 завершені 22.10.2026: DLL із D3D11 API,
апаратний context probe та source audit пройшли (див. `mpv-d3d11-candidate.md`).
Далі потрібні player factory, інтеграція у повну тестову LampaUa та приймання на
реальному 86.47-ГБ торенті. Немає підтвердження для 4К output/60 FPS, A/V sync
або actual HEVC decoder у цьому транспортному тесті.

Production manifest і прийнята DLL не змінені:

```text
build/libmpv-runtime.json
775c07b69173376405c7910f15eaf7460716234846f57358cb1e39bc5abf8fa0
.cache/mpv-prototype/sdk/libmpv-2.dll
5abe5c6a7714025a9af8fba34313b4fab762333f45b8d34ad13c9f220421671d
```
