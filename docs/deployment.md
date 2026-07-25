# Deployment

Start with a foreground process. Move to unattended operation only after the
same configuration, Codez build, bot, chat, and workspace pass a complete
operator smoke.

## Deployment invariants

- Exactly one active long poller owns a Telegram bot.
- The env file and state root are readable only by the service account.
- The workspace contains no unrelated sensitive data.
- Codez and optional plugin versions are pinned and reviewed.
- Remote hosts are independently trusted and hardened.
- A state backup and rollback procedure exist before upgrade.

## Foreground

Foreground mode is the portable baseline:

```sh
npm start -- --env-file /absolute/path/to/teledex.env
```

Use terminal interruption for a controlled stop. Confirm that child processes
exit before starting another generation.

## Linux systemd user service

The built-in installer supports Linux with systemd 250 or newer:

```sh
ENV_FILE=/absolute/path/to/teledex.env node src/cli/install-user-service.js
systemctl --user status teledex.service
journalctl --user -u teledex.service -f
```

The generated unit:

- uses `UMask=0077`;
- starts the checked-out `src/cli/run.js`;
- restarts after process exit;
- uses `KillMode=control-group` and `SIGINT`;
- records absolute Node, Codez, config, repository, and env-file paths.

The installer enables and starts an inactive unit. If the unit is already
active, it updates the file without blindly restarting it. Review the generated
unit under `~/.config/systemd/user/teledex.service`.

For startup before the first login after reboot, configure user lingering
according to local host policy. The installer reports but does not enable it.

To remove the service:

```sh
systemctl --user disable --now teledex.service
rm ~/.config/systemd/user/teledex.service
systemctl --user daemon-reload
```

Removing the unit does not remove state, workspaces, Codez sessions, or the
checkout.

## Windows

The repository includes foreground wrappers under `scripts\windows`:

```bat
scripts\windows\install.cmd
scripts\windows\doctor.cmd
scripts\windows\run.cmd
```

Those wrappers rely on the default Windows env-file lookup, including a
repository `.env`. For an explicit path, invoke Node directly:

```powershell
node src/cli/doctor.js --env-file C:\secure\teledex.env
node src/cli/run.js --env-file C:\secure\teledex.env
```

No native Windows Service installer is included. If a third-party service
manager is used, validate signal propagation, child-process cleanup, restart
behavior, working directory, PATH, and NTFS ACLs.

## macOS

Foreground Node execution is the documented macOS path. An unattended process
manager is outside this repository's tested service surface and must be
validated by the operator.

## Remote execution

Remote mode launches Codez App Server v2 over SSH-backed stdio and can use file
staging. The implementation targets a POSIX-style remote environment, not an
arbitrary SSH server. It requires:

- reviewed host-registry records;
- noninteractive SSH authentication scoped to the service account;
- trusted host keys and restricted credentials;
- Bash with `bash -lc`, POSIX paths and core utilities, OpenSSH, and `rsync`;
- matching remote workspace paths and compatible Codez behavior;
- remote provider credentials and tool dependencies;
- independent logging, state, retention, and incident controls.

Do not describe a remote host as sandboxed merely because its binding path is
validated.

## Upgrades and rollbacks

1. Read the changelog and compatibility notes.
2. Back up the state root.
3. Install dependencies from the lockfile.
4. Run local and live release gates with the candidate versions.
5. Roll out one generation and verify polling, progress, files, and resume.
6. Keep the previous checkout and backup available until the new generation
   drains cleanly.

The generation-handover mechanism is described in
[Architecture](./architecture.md). It reduces interruption but does not replace
a backup or rollback plan.
