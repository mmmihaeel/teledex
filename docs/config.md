# Configuration

Pass an explicit private env file:

```sh
npm start -- --env-file teledex.env
```

The equivalent process variable is `ENV_FILE=/absolute/path/to/teledex.env`.
Values already present in the process environment override values loaded from
the file.

Without an explicit path, Teledex looks for:

- Windows: `.env` in the repository, then
  `%LOCALAPPDATA%\teledex\runtime.env`.
- Linux and macOS: `$XDG_STATE_HOME/teledex/runtime.env`, or
  `~/.local/state/teledex/runtime.env`.
- A repository `.env` on non-Windows platforms only when
  `TELEDEX_ALLOW_REPO_ENV=1`.

Do not commit any populated env file.

## Required settings

| Variable | Meaning |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFather token used for Telegram Bot API calls. |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated numeric operator identifiers. At least one user is required. |
| `TELEGRAM_FORUM_CHAT_ID` | Numeric identifier of the single forum-enabled supergroup Teledex serves. |

`TELEGRAM_ALLOWED_USER_ID` remains accepted as a singular compatibility input.
`TELEGRAM_ALLOWED_BOT_IDS` optionally authorizes bot principals; treat them as
fully trusted operators.

## Recommended boundaries

| Variable | Default | Guidance |
| --- | --- | --- |
| `TELEDEX_WORKSPACE_ROOT` | Parent of the Teledex checkout | Set an explicit dedicated root. It constrains binding resolution, not agent authority. |
| `TELEDEX_STATE_ROOT` | Platform state directory | Set an explicit private path and include it in backup policy. |
| `CODEX_BIN_PATH` | `codex`, or `codex.cmd` on Windows | Prefer an absolute path for services. |
| `CODEX_CONFIG_PATH` | `~/.codex/config.toml` | Use a dedicated profile when Teledex must not inherit an interactive profile. |
| `DEFAULT_SESSION_BINDING_PATH` | Workspace root | Initial binding for sessions without a narrower path. |

Default state is `%LOCALAPPDATA%\teledex` on Windows and
`$XDG_STATE_HOME/teledex` or `~/.local/state/teledex` elsewhere.

## Backend selection

App Server v2 is the supported public backend and is selected when
`TELEDEX_BACKEND` is omitted.

If the backend is explicit, enable it explicitly as well:

```env
TELEDEX_BACKEND=app-server-v2
TELEDEX_ENABLE_APP_SERVER_V2=1
```

Teledex spawns:

```text
codex app-server --listen stdio:// --enable goals
```

There is no configurable HTTP App Server URL in this release. Legacy backends
remain implementation compatibility paths and are not part of the public
setup contract.

## Runtime controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_MODEL` | Codez config, then runtime default | Initial model for new sessions. |
| `CODEX_REASONING_EFFORT` | Codez config, then runtime default | Initial reasoning level. |
| `CODEX_CONTEXT_WINDOW` | Codez config | Context-window metadata. |
| `CODEX_AUTO_COMPACT_TOKEN_LIMIT` | Codez config | Automatic compaction threshold. |
| `MAX_PARALLEL_SESSIONS` | `10` | Maximum concurrent sessions. |
| `TELEGRAM_POLL_TIMEOUT_SECS` | `30` | Long-poll timeout. |
| `PARKED_SESSION_RETENTION_HOURS` | `168` | Minimum age before an eligible parked session can be purged. |
| `RETENTION_SWEEP_INTERVAL_SECS` | `60` | Parked-session sweep interval. |
| `TELEGRAM_EXPECTED_TOPICS` | empty | Informational expected-topic labels echoed by diagnostics; Teledex does not enumerate or verify those topics. |
| `TELEDEX_ALLOW_SYSTEM_TEMP_DELIVERY` | disabled | Allow outbound files from the system temp directory. Expands the delivery boundary. |

`CODEX_SESSIONS_ROOT`, `CODEX_LIMITS_SESSIONS_ROOT`,
`CODEX_LIMITS_COMMAND`, `CODEX_LIMITS_CACHE_TTL_SECS`, and
`CODEX_LIMITS_COMMAND_TIMEOUT_SECS` control rate-limit inspection and Codez
session discovery. Leave them at their defaults unless the Codez installation
uses nonstandard paths.

## MCP and optional plugins

`TELEDEX_MCP_PRESET` accepts `none` or `workspace`.

`TELEDEX_RTK_PLUGIN_MODE` and `TELEDEX_PITLANE_PLUGIN_MODE` accept `off`,
`path`, or `github`; both default to `off`. Despite the mode name, `github`
uses an already-present Codex plugin cache and does not download from GitHub.
`path` requires the matching `TELEDEX_RTK_PLUGIN_PATH` or
`TELEDEX_PITLANE_PLUGIN_PATH`.

Plugin synchronization replaces the managed cache directory and writes hook
trust entries into the Codez configuration. Review the plugin source and
generated configuration before enabling it.

## Host and provider settings

Remote-host, registry, DeepSeek, and OpenRouter variables support advanced
deployments. They are intentionally absent from the starter env file. Review
[Architecture](./architecture.md), [Deployment](./deployment.md), and the
corresponding source modules before enabling them.

## File permissions

Teledex requests `0700` directories and `0600` files on POSIX systems. Windows
does not apply equivalent ACLs automatically; restrict the env and state paths
to the service account with Windows ACLs.
