# LampaUa Desktop

Десктопний клієнт LampaUa для Windows, macOS і Linux.

## Про проєкт

LampaUa Desktop — це неофіційна адаптація десктопного клієнта `Kolovatoff/lampa-desktop` для сервера LampaUa.

Ми зробили форк оригінального проєкту, змінили назву, стартову адресу, налаштування, релізи та автооновлення, щоб застосунок був зручним для користувачів LampaUa.

Проєкт не є офіційним релізом оригінальної Lampa і не пов’язаний з авторами оригінального проєкту. Усі права на оригінальний код належать його авторам. Зміни LampaUa публікуються у відкритому репозиторії з дотриманням ліцензії оригінального проєкту.

Оригінальний проєкт: `https://github.com/Kolovatoff/lampa-desktop`

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
