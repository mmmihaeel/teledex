# Contributing

Thank you for improving Teledex. Keep changes focused, reviewable, and aligned
with the documented trusted-operator model.

## Development setup

```sh
git clone https://github.com/mmmihaeel/teledex.git
cd teledex
npm ci
npm run check:syntax
npm test
```

Use placeholder credentials in tests and examples. Never commit bot tokens,
provider keys, Telegram identifiers, host inventories, session state, logs, or
machine-specific paths.

## Change checklist

1. Describe the behavior and its trust boundary.
2. Add or update focused tests.
3. Keep documentation and examples consistent with runtime behavior.
4. Run syntax, lint, type, and unit-test checks.
5. Run live checks only with disposable infrastructure and explicit operator
   intent.
6. Review the final diff for credentials, personal data, generated state, and
   unsupported claims.

See [Testing](./docs/testing.md), [Security](./docs/security.md), and the
[documentation index](./docs/index.md).

## Pull requests

Prefer one coherent change per pull request. Include:

- the problem and chosen behavior;
- security, state, and deployment implications;
- commands run and results;
- checks intentionally skipped;
- rollback or compatibility notes when behavior changes.

Do not include generated PDFs, runtime logs, or live state unless the repository
explicitly tracks the artifact and its source is reproducible.
