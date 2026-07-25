# Teledex Runbook

This runbook assumes a private env file, a dedicated state root, and a trusted
operator allowlist.

## Preflight

Confirm:

- only one poller is active for the bot;
- the intended env file, state root, workspace, Codez executable, and Codez
  config are selected;
- no unreviewed plugin synchronization or remote-host change is pending;
- the Telegram supergroup still has topics enabled;
- the bot still has topic-management and message-deletion permissions.

Run:

```sh
npm run doctor -- --env-file teledex.env
```

Remember that `doctor` writes state and contacts Telegram. It does not start
Codez or validate model-provider access.

## Foreground operations

Start:

```sh
npm start -- --env-file teledex.env
```

Stop with a terminal interrupt and wait for child processes to exit. If the
process was killed abruptly, inspect active Codez processes and session state
before restarting.

## Linux service operations

```sh
systemctl --user status teledex.service
journalctl --user -u teledex.service -n 200
systemctl --user restart teledex.service
systemctl --user stop teledex.service
systemctl --user start teledex.service
```

Before restarting a busy service, check for active runs. Prefer a controlled
rollout or maintenance window over an unconditional restart.

## Startup validation

After every install, restore, or rollout:

1. Check process and service health.
2. Review recent logs for polling or configuration errors.
3. Send `/status` in General.
4. Create or use a disposable work topic.
5. Run a low-risk prompt.
6. Verify progress editing and the final response.
7. Verify interrupt and restart/resume behavior.
8. Verify a small inbound attachment and safe outbound artifact.
9. Confirm that unexpected users, bots, chats, and private commands are
   rejected.

With no saved update offset, the newest update observed at startup is used only
to establish the offset. Send a fresh message for validation.

## Smoke command

```sh
npm run smoke -- --env-file teledex.env
```

Use this only on Linux with a dedicated test bot and chat. The command:

- verifies that the known systemd service is inactive;
- starts Teledex in a temporary run-once polling mode;
- can remove an existing webhook;
- can establish or advance the saved update offset.

It must not run alongside another webhook or poll consumer for the same bot.

## Backup

1. Stop or drain Teledex.
2. Capture the exact application and Codez versions.
3. Back up the complete state root with permissions and timestamps.
4. Store the backup in a protected location.
5. Test restore to an isolated path and disposable bot before relying on it.

Workspace and Codez session backups are separate from the Teledex state backup.

## Restore

1. Keep the damaged or uncertain state tree unchanged for investigation.
2. Restore a complete snapshot to a separate path.
3. Point a test env file to that path.
4. Run `doctor`.
5. Start one foreground generation.
6. Validate a disposable topic and inspect ownership and queue state.
7. Promote the restored path only after consistency is established.

Do not merge files from active and restored state trees.

## Incident: polling conflict

Symptoms include duplicate responses, Telegram conflict errors, or rapidly
changing offsets.

1. Stop every Teledex, webhook, and alternate poll consumer for the bot.
2. Confirm a single intended process.
3. Inspect webhook state with `doctor`.
4. Preserve state and logs before changing offsets.
5. Start one foreground process and send a fresh test update.

## Incident: topic unavailable

1. Confirm the topic exists and is open.
2. Confirm the bot remains a supergroup member with required permissions.
3. Inspect whether the session was parked.
4. Reopen the topic or create a replacement according to operator policy.
5. Validate delivery before resuming sensitive work.

## Incident: Codez failure

1. Stop repeated retries if they can mutate the workspace.
2. Record the selected host, model, binding, thread, and goal.
3. Resolve `CODEX_BIN_PATH` under the service account.
4. Run the exact Codez build in a disposable workspace.
5. Check provider credentials without printing them.
6. Preserve Teledex and Codez logs and state.
7. Resume only after the failure mode is understood.

## Purge and retention

Use `/purge` only after confirming the target topic and preservation
requirements. A Teledex purge does not remove Telegram history, Codez sessions,
remote files, provider logs, system logs, or backups.

See [State contract](./state-contract.md) and
[Troubleshooting](./troubleshooting.md).
