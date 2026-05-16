# LampaUa Desktop

Десктопний клієнт LampaUa на базі Electron.

Проєкт зроблено на основі `Kolovatoff/lampa-desktop` і адаптовано під сервер LampaUa.

LampaUa Desktop is an unofficial fork/adaptation of `Kolovatoff/lampa-desktop` and is not affiliated with the original Lampa project.

- стартова адреса за замовчуванням: `http://lampaua.mooo.com`;
- назва застосунку: `LampaUa`;
- окремий `appId`: `com.lampaua.desktop`;
- власні артефакти збірки: `lampaua-${arch}-${version}`;
- автооновлення орієнтоване на релізи `Hlushok/lampaua-desktop`;
- вбудовані налаштування LampaUa, TorrServer, зовнішніх плеєрів, імпорту/експорту.

## Розробка

```bash
corepack yarn install
corepack yarn dev
```

## Збірка

```bash
corepack yarn build-win
corepack yarn build-linux
corepack yarn build-mac
```

## Реліз

GitHub Actions автоматично збирає та публікує `.exe`, `.dmg`, `.deb`, `.rpm` і `.AppImage`, коли в GitHub потрапляє тег `v*`.

Для звичайного bugfix-релізу:

```bash
corepack yarn release
```

Для явного типу версії:

```bash
corepack yarn release:patch
corepack yarn release:minor
corepack yarn release:major
```

Ці команди оновлюють версію, CHANGELOG, створюють git-тег і пушать зміни на GitHub. Після пушу тега GitHub сам запускає збірку релізу.

## Перший запуск

Після запуску застосунок відкриває:

```text
http://lampaua.mooo.com
```

Адресу можна змінити в налаштуваннях застосунку, але для LampaUa рекомендовано залишати адресу за замовчуванням.

## Ліцензія та походження

Початковий проєкт: `https://github.com/Kolovatoff/lampa-desktop`.

Зміни LampaUa зберігаються в окремому форку/проєкті, щоб мати власні релізи, брендинг і оновлення.
