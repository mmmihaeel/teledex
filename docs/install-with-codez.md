# Install Teledex with Codez

Teledex launches Codez App Server v2 on demand. It does not connect to a
long-lived HTTP App Server endpoint.

## Prerequisites

- Node.js `^20.19.0`, `^22.13.0`, or `>=24` and npm for installation from
  source with the locked contributor toolchain.
- A PATH-visible `codex` command from
  [Codez](https://github.com/mmmihaeel/codez), or an absolute
  `CODEX_BIN_PATH`.
- A Telegram bot token created through BotFather.
- A forum-enabled Telegram supergroup.
- The bot added to that supergroup with permission to manage topics and delete
  messages.
- Numeric Telegram identifiers for the supergroup and every trusted operator.
- A dedicated workspace, state directory, and preferably a dedicated
  operating-system account or host.

Remote execution additionally requires reviewed host-registry data,
noninteractive SSH authentication, and a POSIX-style target with Bash,
OpenSSH, and `rsync`. See
[Deployment](./deployment.md).

## Install

For a release deployment, check out a published version tag instead of a
moving branch.

```sh
git clone https://github.com/mmmihaeel/teledex.git
cd teledex
git checkout v0.1.0
npm ci
cp examples/teledex.env.example teledex.env
mkdir -p ../teledex-workspace ../teledex-state
$EDITOR teledex.env
```

In Windows PowerShell, create the same paths with:

```powershell
New-Item -ItemType Directory -Force ..\teledex-workspace, ..\teledex-state
```

The minimum private configuration is:

```env
TELEGRAM_BOT_TOKEN=replace-me
TELEGRAM_ALLOWED_USER_IDS=replace-me
TELEGRAM_FORUM_CHAT_ID=replace-me
```

The example also sets explicit workspace, state, executable, and backend
values. See [Configuration](./config.md) before changing advanced options.

## Validate Telegram and state

```sh
npm run doctor -- --env-file teledex.env
```

`doctor` contacts Telegram, validates the bot and forum chat, inspects the
bot's membership and permissions, reports webhook state, initializes the state
layout, writes `logs/doctor-last-run.json`, and inspects systemd metadata when
available.

It does not launch Codez, validate model credentials, or prove App Server v2
and goal compatibility.

## First foreground run

Stop any other webhook or long-poll consumer for the same bot, then run:

```sh
npm start -- --env-file teledex.env
```

Telegram stores its default and language-specific command catalogs
independently. If this bot was previously configured by another build, clear
every non-default command catalog through BotFather or the Bot API before the
first Teledex start. Teledex publishes the default English catalog but cannot
enumerate language codes retained by Telegram.

Startup behavior matters:

- If the bot has a webhook, Teledex removes it with
  `drop_pending_updates=false` before long polling.
- With no saved update offset, Teledex reads the newest update only to establish
  an offset. That update is not routed. Send a fresh `/status` or test prompt
  after startup.
- Group updates are accepted only from the configured forum chat and
  allowlisted user or bot identifiers. Allowlisted human users can also reach
  the isolated private emergency-repair lane described in the
  [Telegram surface](./telegram-surface.md).

In Telegram General, create a disposable topic and send a low-risk prompt.
Confirm progress, final response, interruption, restart/resume, and deletion
behavior before running Teledex unattended.

## Next steps

- Learn the operator flow in the [Guidebook](./guidebook-eng.md).
- Choose a deployment mode in [Deployment](./deployment.md).
- Apply the [Security](./security.md) hardening checklist.
- Use the [Runbook](./runbook.md) for upgrades and incidents.
