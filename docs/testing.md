# Testing and Release Gates

Teledex separates source verification, publication checks, live Codez
integration, and live Telegram operation. Passing one layer does not imply the
others passed.

## Local source checks

After a lockfile install:

```sh
npm ci
npm run check:syntax
npm run lint
npm run typecheck
npm test
npm run smoke:config
```

| Check | What it establishes | Important limit |
| --- | --- | --- |
| `check:syntax` | JavaScript parses under the current Node runtime. | Does not execute behavior. |
| `lint` | Configured static rules pass. | Only configured rules and paths are covered. |
| `typecheck` | The repository TypeScript configuration passes. | `checkJs` and strict mode are disabled; this is not full static typing. |
| `test` | Non-live Node test files pass. | Files containing `.live.` are excluded. |
| `smoke:config` | The example has expected placeholder keys and selected values. | It does not load the full runtime config or contact dependencies. |
| `npm audit --omit=dev` | npm reports known production dependency advisories at that moment. | Results are registry- and time-dependent. |

## Public-tree audit

`npm run audit:public` audits the current tree and rejects local install or
build paths such as `node_modules`. Run it in a fresh release archive:

```sh
git archive --format=tar --prefix=teledex-release/ HEAD > teledex-release.tar
mkdir teledex-release-audit
tar -xf teledex-release.tar -C teledex-release-audit
node teledex-release-audit/teledex-release/scripts/audit-public-projection.mjs \
  teledex-release-audit/teledex-release
```

The audit verifies:

- an exact expected-file inventory;
- required source, test, documentation, and help-card paths;
- exactly two English help-card PNGs with valid dimensions;
- absence of selected private paths, secret-shaped values, legacy repository
  identities, non-English locale markers, and non-English public text;
- the supported backend and command-surface constraints.

It does not:

- inspect Git objects, commit authors, tags, branches, or remotes;
- prove that placeholders are safe in every context;
- perform a dependency or license audit;
- read text embedded in images;
- execute tests;
- establish that documentation claims match runtime behavior.

Review generated and binary assets visually in addition to running the audit.

## Live App Server v2 suite

```sh
npm run test:live:app-server-v2 -- --env-file teledex-live.env
```

The suite uses a mock Telegram API but starts a real Codez process in the
current checkout. It can execute commands, modify its disposable workspace,
contact model providers, and consume quota. The env file still needs parseable
placeholder Telegram values because runtime configuration is loaded.

Run it only with:

- a dedicated disposable workspace;
- an exact pinned Codez release or commit;
- purpose-specific provider credentials;
- reviewed model and reasoning settings;
- retained logs and version evidence.

## Live Telegram smoke

The automated `smoke` command is Linux-only and starts a short-lived poller. It
refuses to run when the known user service is active, but the operator must
also exclude unrelated webhook and poll consumers.

It can remove a webhook and change the saved Telegram update offset. Use a
dedicated test bot, forum supergroup, state root, and workspace.

Manual release smoke should cover:

1. startup with no saved offset and a fresh post-start message;
2. General authorization and rejection of unexpected users, bots, and chats;
3. `/new`, normal prompt, `/q`, `/wait`, steering, and `/interrupt`;
4. progress edits and final response;
5. inbound attachment and bounded outbound artifact;
6. `/goal`, `/compact`, restart/resume, and guarded `/purge`;
7. topic closure, parking, reopen, and recovery;
8. private emergency repair in a disposable Teledex checkout when that path is
   claimed by the release;
9. remote execution separately when claimed by the release.

## Release gate

Before tagging:

1. Freeze the intended source state.
2. Confirm author name and email for every new commit and the annotated tag.
3. Search tracked text, paths, and binary assets for old identities and
   non-English content.
4. Run the public audit against a clean archive.
5. Run local checks on supported Node versions.
6. Run dependency and license review.
7. If the release claims live Codez compatibility, run the App Server v2 suite
   with the exact Codez version named in the release notes. Otherwise omit the
   claim and record that the live suite was not run.
8. If the release claims live Telegram validation, run a dedicated Telegram
   smoke. Otherwise record that the smoke was not run.
9. Build a deterministic archive with one top-level directory and create
   `SHA256SUMS`.
10. Extract the final archive and repeat the public and local checks.
11. Verify executable mode on `src/cli/run.js`, line endings, Windows wrappers,
    tag target, and release checksum.

Suggested deterministic source archive:

```sh
git archive --format=tar --prefix=teledex-v0.1.0/ v0.1.0 \
  | gzip -n > teledex-v0.1.0.tar.gz
sha256sum teledex-v0.1.0.tar.gz > SHA256SUMS
```

Release notes should name Node and Codez versions, supported deployment modes,
tests actually run, checks skipped, known limitations, the trusted-operator
warning, and artifact checksums. Do not add CI, production-readiness, live
validation, or compatibility claims without corresponding evidence.
