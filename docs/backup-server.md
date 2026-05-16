# API резервних копій LampaUa Desktop

Десктопний застосунок використовує Lampac-модуль `DesktopBackup`.

Endpoint-и:

- `POST /database/desktop-backup/upload.php`
- `GET /database/desktop-backup/download.php?id=1234567890`

Копія серверної реалізації зберігається в цьому репозиторії:

```text
server/lampac-mods/DesktopBackup
```

На сервері модуль треба покласти в кастомні модулі Lampac:

```text
/opt/lampac/mods/DesktopBackup
```

У `init.conf` для `accsdb.whitepattern` має бути дозволений шлях:

```json
"whitepattern": "^/(database/desktop-backup/|tmdb/(api|img)/|tgbot/api/monobank/webhook/|adminpanel/tgbot/api/monobank/webhook/)"
```

Модуль зберігає файли backup-ів прямо в папці:

```text
/opt/lampac/database/desktop-backup
```

Файли живуть 1 годину. Дані приходять уже зашифрованими PIN-кодом на стороні клієнта.
