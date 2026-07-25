# Project Catalog

Project Catalog is an optional Telegram topic for discovering and presenting
projects under the configured workspace. The source uses the internal `zoo`
name, while the operator-facing feature is Project Catalog.

## What it does

- Creates or restores a dedicated Project Catalog forum topic.
- Resolves candidate projects through the normal workspace binding rules.
- Stores project records and presentation metadata under the Teledex state
  root.
- Can run Codez-backed lookup and analysis for a selected project.
- Presents projects through a lightweight character and status interface.

## What it does not do

- It does not change the supported App Server v2 backend.
- It does not sandbox project analysis.
- It does not make a project path safe merely because it is cataloged.
- Removing a catalog entry does not delete the repository.
- Teledex session purge does not necessarily remove all catalog snapshots, and
  catalog deletion does not remove Codez or provider records.

## Trust and data

Project lookup and analysis can expose repository paths, metadata, and source
content to Codez and configured model providers. Catalog state is sensitive
and follows the same access, backup, and retention requirements as other
Teledex state.

Use `/zoo` from General to open the catalog. Add only projects already approved
for the Teledex service account and provider configuration.
