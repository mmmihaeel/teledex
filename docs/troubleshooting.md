# Troubleshooting

Start with the exact env file used by the process:

```sh
npm run doctor -- --env-file teledex.env
```

`doctor` validates Telegram, state, and available systemd metadata. It does not
launch Codez or verify provider access.

| Symptom | Likely cause | Check and response |
| --- | --- | --- |
| Missing required runtime setting | Wrong env path or absent Telegram value | Pass `--env-file` explicitly; verify the three required values without printing secrets. |
| Bot or chat probe fails | Invalid token, wrong supergroup, bot removed, or topics disabled | Confirm BotFather token, numeric forum chat ID, membership, and forum mode. |
| Bot can read but cannot manage topics or cleanup messages | Missing Telegram permissions | Grant only the required topic-management and message-deletion permissions, then rerun `doctor`. |
| First post-start message is ignored | No saved offset existed | This is the bootstrap offset behavior. Send a fresh message after startup. |
| Duplicate replies or Telegram conflict errors | Multiple webhook or poll consumers | Stop every consumer for the bot, inspect webhook state, preserve offset state, then start one foreground instance. |
| `/guide` or `/help` cannot upload | Missing generated asset, Telegram file error, or topic unavailable | Verify the English assets, file size, bot permissions, and topic state. |
| Codez executable not found | Service PATH differs from interactive shell | Set absolute `CODEX_BIN_PATH`; inspect the generated systemd unit and service-account PATH. |
| App Server starts but request fails | Incompatible Codez protocol, goals support, provider config, or model | Pin the Codez build, run the live suite in a disposable workspace, and inspect JSONL/RPC errors. |
| Prompt starts in an unexpected directory | Binding or default path differs from expectation | Inspect topic status, host selection, and `DEFAULT_SESSION_BINDING_PATH`; do not assume binding is a sandbox. |
| Outbound file is rejected | File exceeds 45 MiB or lies outside allowed roots | Move a reviewed artifact into the bound workspace or session state and reduce its size. Avoid enabling system-temp delivery globally. |
| Incoming attachment is rejected | File exceeds the 20 MiB soft limit or download failed | Send a smaller file and inspect Telegram download errors. |
| Topic stops receiving updates | Telegram topic closed, deleted, or unavailable | Inspect parked session state, reopen or replace the topic, then validate delivery. |
| Parked state is not purged | Session is too new, pinned, busy, compacting, or owns queued work | Review lifecycle metadata before changing retention or using `/purge`. |
| systemd install fails | Non-Linux host, systemd older than 250, unresolved Codez, or user manager unavailable | Use foreground mode or correct the documented Linux prerequisites. |
| Service works interactively but not after reboot | User linger is disabled or service environment is incomplete | Check `loginctl`, absolute paths, generated unit, and user journal. |
| Remote task cannot start | SSH, host key, registry, remote path, staging, or remote Codez mismatch | Test the host with disposable inputs and inspect both local and remote logs. |
| Windows state appears readable by other accounts | POSIX modes do not apply on Windows | Restrict the env and state paths with explicit NTFS ACLs. |

## Safe evidence collection

Capture:

- Teledex and Codez versions;
- operating system and Node version;
- selected backend and host identifier;
- timestamps, exit codes, and sanitized error messages;
- the state path and topic identifier only when sharing them is safe.

Do not paste bot tokens, provider keys, private prompts, full env files, host
inventories, or unredacted state into public issues.

For incidents, follow the [Runbook](./runbook.md). For trust-boundary questions,
read [Security](./security.md).
