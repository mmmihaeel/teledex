# State Contract

`TELEDEX_STATE_ROOT` is a sensitive, mutable runtime store. Keep it outside the
source checkout and include it in an explicit access, backup, retention, and
deletion policy.

## Layout

```text
TELEDEX_STATE_ROOT/
|-- sessions/          topic metadata, briefs, exchanges, progress, artifacts
|-- indexes/           lookup and routing indexes
|-- settings/          global and topic settings
|-- hosts/             host registry state and synchronization metadata
|-- teledex-context/   runtime context shared with Codez workflows
|-- zoo/               Project Catalog topic and project snapshots
|-- emergency/         private-lane state
|-- logs/              diagnostics and operational snapshots
`-- tmp/               generated guidebooks and transient work
```

Depending on enabled features, the tree can contain:

- prompts, replies, briefs, progress, and exchange logs;
- Telegram chat, user, bot, message, and topic identifiers;
- local and remote filesystem paths and host metadata;
- incoming attachments and staged outbound artifacts;
- Codez thread, rollout, model, and runtime identifiers;
- queued or buffered input and control-panel settings;
- diagnostic reports such as `logs/doctor-last-run.json`.

Treat the complete tree as confidential even when no provider key is expected
inside it.

## Permissions

On POSIX systems, Teledex requests mode `0700` for managed directories and
`0600` for managed files. These modes protect against other local accounts but
do not protect against the service account, root, backups, or compromised
plugins and tools.

On Windows, Teledex skips POSIX mode operations. Apply restrictive NTFS ACLs to
the state root and private env file before first use.

## Lifecycle and retention

Active session state has no general time-to-live. A session may be parked when
its Telegram topic is closed or unavailable. By default:

- an eligible parked session reaches retention age after 168 hours;
- the retention sweep runs every 60 seconds;
- pinned, busy, compacting, or claimed-queue sessions are not eligible;
- purge removes session content but can leave a minimal purged metadata stub.

`/purge` affects Teledex session state. It does not guarantee deletion from:

- Telegram messages and files;
- Codez's separate sessions directory, normally `~/.codex/sessions`;
- provider logs, remote hosts, shell history, operating-system logs, backups,
  or copied artifacts.

## Backup and restore

1. Stop the poller or enter a controlled maintenance window.
2. Record the Teledex and Codez versions and the absolute state and workspace
   paths.
3. Back up the entire state root with permissions and timestamps preserved.
4. Protect the backup as sensitive data.
5. Restore to a test account first and run `doctor`.
6. Start one foreground generation and validate a disposable topic before
   restoring unattended service.

Do not merge partial state trees from concurrently running generations. If
recovery is uncertain, preserve the original tree, restore a complete snapshot
to a separate path, and point a disposable test configuration at it.
