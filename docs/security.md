# Security Model

## Primary trust statement

Teledex is a remote control plane for a trusted operator. It is not a
multi-tenant service and does not sandbox Codez.

Codez sessions are started with:

```text
approvalPolicy=never
sandbox=danger-full-access
```

Workspace binding prevents Teledex from accepting an initial path outside the
configured root. It does not constrain what the agent, shell, tools, plugins,
or child processes can access afterward. An authorized operator effectively
receives the filesystem, process, network, credential, and remote-host
authority of the account running Teledex.

## Authorization boundary

Teledex checks:

- the configured forum supergroup for group updates;
- `TELEGRAM_ALLOWED_USER_IDS` or the singular compatibility value;
- optional `TELEGRAM_ALLOWED_BOT_IDS`;
- the command and lane context.

Keep all allowlists narrow. A bot identifier is not less privileged than a user
identifier. Telegram account compromise, bot-token theft, or an authorized
automation bug can become host compromise.

Use a dedicated bot and supergroup. Do not reuse the bot with another poller or
webhook integration.

### Private emergency execution

An allowlisted human's private messages bypass the normal forum-topic session
pipeline. `/help`, `/status`, and `/interrupt` control the lane; other text,
plus any buffered attachments, becomes a prompt for one isolated `codex exec`
process rooted at the Teledex repository.

The router blocks a second emergency run and refuses to start one while normal
topic runs are active. Those concurrency guards do not reduce process
authority: the emergency child can modify the gateway checkout and exercise
the service account's host permissions. Keep the checkout recoverable, review
its diff after use, and reserve this path for gateway repair.

## Host isolation

Recommended deployment:

- dedicated operating-system account or dedicated host;
- dedicated workspace with no unrelated repositories or secrets;
- dedicated state and Codez config paths;
- minimal provider and SSH credentials;
- outbound network controls appropriate to the tools;
- no interactive desktop session or personal home-directory data;
- tested backups and rapid credential revocation.

Containers or virtual machines can reduce blast radius only when their mounts,
network, credentials, device access, and host interfaces are also restricted.

## Secrets and child processes

The bot token and env file remain sensitive. Teledex filters Telegram and
Teledex configuration variables from the Codez child environment, while
retaining model-provider variables needed by the agent runtime. This reduces
accidental bot-token exposure but does not make the child process untrusted or
contained.

Never place unrelated secrets in:

- the workspace;
- Teledex state;
- prompt attachments;
- shell startup files visible to the service account;
- a shared Codez configuration;
- plugin source or host-registry records.

Telegram bot messages should not be treated as end-to-end confidential storage.

## State and local permissions

State can contain prompt and response text, Telegram identifiers, attachments,
paths, host metadata, logs, queues, and Codez identifiers. POSIX file modes are
requested as `0700` and `0600`; Windows ACLs must be configured separately.

Backups, exported logs, remote hosts, and Codez's own session directory need
the same or stronger controls.

## Webhook and polling ownership

Teledex removes an existing webhook at startup with pending-update deletion
disabled. The first run without a saved offset consumes the newest update to
establish the offset. Treat bot ownership and offset state as operational
security controls: an unexpected second consumer can intercept or duplicate
commands.

## Plugins and MCP

Optional RTK and Pitlane integrations are executable Codex hooks. Plugin
synchronization can replace managed cache directories and update hook-trust
entries in the Codez config. The mode named `github` resolves an existing local
Codex cache; it does not fetch and verify a release.

Review source, provenance, executable permissions, hook configuration, and
updates before enabling any plugin or MCP server. Apply the same scrutiny to
remote tools exposed through Codez.

## Remote hosts

Remote execution expands trust to SSH credentials, remote Codez and tool
versions, remote filesystems, and file-staging paths. Use pinned host keys,
least-privilege accounts, isolated workspaces, and per-host revocation. A
validated remote binding is not a sandbox.

## Public-source audit limits

`npm run audit:public` checks the exported file inventory, forbidden paths,
selected secret-shaped values, repository identity markers, non-English
public text, and help-card structure. It does not inspect Git history, validate
dependency integrity, prove that an image contains only expected text, or
replace a manual security review.

## Hardening checklist

- Use a dedicated bot, supergroup, account, workspace, state root, and Codez
  profile.
- Authorize only operators who should control the entire service account.
- Disable optional bots, plugins, MCP servers, temp delivery, providers, and
  remote hosts until required.
- Pin and verify Codez and plugin versions.
- Protect env, state, Codez sessions, logs, and backups.
- Monitor polling conflicts, authorization failures, new host entries, and
  plugin-config changes.
- Test credential rotation, state restore, and service rollback.
- Review every release against [Testing](./testing.md).

For private reporting instructions, see [SECURITY.md](../SECURITY.md).
