# config_v

Серверная часть семейного VPN: **Xray / VLESS / REALITY / Vision**. Обычный HTTPS-запрос получает простую страницу Caddy на том же внешнем TCP-порту; VPN-клиент с подходящими ключами получает туннель.

Код готовит отдельные узлы. Резервный сервер должен работать независимо от основного; переключение между ними — задача клиента. Гарантии обхода блокировок эта схема не даёт.

## Структура

```text
client/           Vite + React + TypeScript; сайт пока отложен
infra/node/       Terraform: Xray, Caddy, сеть и постоянные тома
infra/colima/     отдельная VM на Mac без общих папок и SSH agent
deploy/templates/ шаблоны Xray и Caddy
tools/            генерация ключей, передача конфигурации, plan/apply
runtime/<node>/   приватные файлы и отдельный Terraform state узла; вне Git
test/             проверки ключей, секретов и развёртывания
```

## Единый запуск и перезапуски

```sh
npm ci --ignore-scripts
npm run init -- --local --env-file deploy/local.env.example
```

Локальный init проверит профиль Colima, запустит остановленную VM, подготовит конфигурацию, выполнит seed/plan/apply/status и проверит настоящий туннель. Альтернатива: `./scripts/init.sh --local --env-file deploy/local.env.example`; этот wrapper установит npm-зависимость, если её ещё нет. Node.js, Docker CLI, Terraform и Colima должны быть установлены. На удалённом VPS Docker и SSH-доступ подготавливаются отдельно.

Для VPS заполните `.env` по [.env.example](.env.example) и запустите `npm run init`. В интерактивном терминале недостающие имя узла, режим, домен и SSH endpoint будут запрошены. Приоритет: CLI → переменные процесса VPN_* → .env → сохранённый узел → defaults. `--env-file` выбирает отдельный файл, например для резерва.

По умолчанию init применяет показанный план. `--prepare-only` только подготовит настройки, `--plan-only` выполнит подготовку томов и сохранит план без apply. Повторный init сохраняет ключи и пользователей; другой Docker endpoint требует нового узла. После изменения домена/SNI, адреса или порта раздайте обновлённые клиентские ссылки.

```sh
npm run restart:vpn -- --node de-main
npm run restart:client -- --node de-main
npm run restart:all -- --node de-main
npm run restart:back -- --node de-main
```

`vpn` — Xray; `client` — сайт в Caddy; `all` — оба сервиса. ОС/VM не перезагружается, ключи и сертификаты сохраняются. `restart:back` зарезервирован для будущего API-бэкенда и пока сообщает, что такого процесса нет. Vite dev server и приложения на телефонах этими командами не перезапускаются. После старого развёртывания выполните init один раз: restart использует запись последнего успешного apply.

DNS-резолверы контейнеров задаются через `VPN_DNS_SERVERS`; hostname и DNS самой Colima — `VPN_VM_HOSTNAME` и `VPN_VM_DNS_SERVERS`. Публичные A/AAAA-записи у регистратора это не создаёт. Работающая Colima не перезапускается автоматически при изменении её настроек.

Подробно по каждому Terraform-файлу, передаче переменных и порядку запуска: [docs/infra-walkthrough.md](docs/infra-walkthrough.md).

## Сначала проверить код

Нужен Node.js 22 или новее. Для проверки YAML Colima используется одна закреплённая зависимость `yaml`; установите её через `npm ci --ignore-scripts`.

```sh
npm run check
```

## Локальный узел в Colima

Установите [Colima](https://colima.run/docs/installation/), Docker CLI и [Terraform](https://developer.hashicorp.com/terraform/install) версии 1.6 или новее. Все команды ниже — из корня репозитория.

```sh
npm run colima:profile
colima start --profile config-v
npm run vpn:init -- --node local --local
npm run vpn:validate -- --node local
npm run vpn:seed -- --node local
npm run vpn:plan -- --node local
npm run vpn:apply -- --node local
npm run vpn:status -- --node local
npm run vpn:smoke -- --node local
```

`colima:profile` выполняется один раз и отказывается перезаписывать существующий профиль. Если профиль уже создан, начинайте с `colima start`. Проверьте в нём `mounts: null`, `forwardAgent: false`, `autoActivate: false`. Пустой список `mounts: []` означает стандартные mounts Colima и для нашего профиля не подходит.

У локального узла HTTPS доступен только на `127.0.0.1:8443`, HTTP — на `127.0.0.1:8080`. Проверка обычного подключения:

```sh
curl --noproxy vpn.test --resolve vpn.test:8443:127.0.0.1 --insecure https://vpn.test:8443/
```

`--insecure` здесь нужен только для тестового внутреннего сертификата Caddy. В production используется публичный сертификат собственного домена. Эта проверка подтверждает HTTPS-ответ; отдельно проверьте доступ через VPN-клиент.

## Добавить устройство

```sh
npm run vpn:add-client -- --node local --name phone-one
npm run vpn:seed -- --node local
npm run vpn:plan -- --node local
npm run vpn:apply -- --node local
```

Ссылка для импорта находится в `runtime/local/clients/phone-one.txt`; JSON для Xray — рядом. Эти файлы дают доступ к VPN. У каждого устройства свой UUID. Ключи REALITY при добавлении устройства сохраняются. Повторный `init` не перезаписывает существующий узел.

Изменение списка клиентов пересоздаёт контейнеры при `apply` и может прервать соединения этого узла. Сначала проверяйте изменения на резервном узле.

## Развёртывание на VPS

На проверенном VPS: Ubuntu 22.04.5 LTS, x86_64, 2 доступных CPU, около 2 ГБ RAM, без swap; `/dev/kvm` отсутствует. Это данные осмотра, а не настройка сервера. Ничего на VPS этими инструментами автоматически не устанавливается.

Перед production нужны собственный домен с DNS на нужный IP, открытые TCP 80/443 и выбранная среда исполнения на VPS. Текущий Terraform-модуль требует Docker API через SSH. Colima подготовлена для Mac; пригодность и изоляцию Docker на VPS нужно решить отдельно. Вложенная VM без доступного KVM не входит в этот вариант.

Когда среда подготовлена, пример генерации:

```sh
npm run vpn:init -- --node de-main --domain vpn.example.com --docker-host ssh://deploy@server.example.com
npm run vpn:validate -- --node de-main
```

Замените примерные имена настоящими. Генерация не подключается к серверу. `seed` проверяет кандидатов настоящими парсерами Xray и Caddy перед заменой рабочих файлов. `plan` и `apply` сверяют содержимое томов; `apply` применяет ранее сохранённый неизменённый план. Для другого VPS создайте новый узел с отдельным состоянием.

См. [архитектуру](docs/architecture.md), [Terraform](docs/terraform.md) и [восстановление](docs/operations.md).

Результаты локальной проверки: [docs/verification.md](docs/verification.md).
