# Teledex public Makefile

TELEDEX_ENV_FILE ?= $(CURDIR)/teledex.env
ENV_FILE ?= $(TELEDEX_ENV_FILE)
NODE ?= node
.PHONY: config doctor run smoke smoke-config lint typecheck check-syntax test test-exec test-cleanup hygiene audit-public test-live test-live-app-server-v2

config:
	@test -f "$(ENV_FILE)" || { \
		echo "Missing runtime env: $(ENV_FILE)" >&2; \
		echo "Copy examples/teledex.env.example to teledex.env and fill placeholders." >&2; \
		exit 1; \
	}

doctor: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/doctor.js

run: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/run.js

smoke: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/run-smoke.js

smoke-config:
	$(NODE) scripts/smoke-config.mjs --env-file examples/teledex.env.example

lint:
	npm run lint

typecheck:
	npm run typecheck

check-syntax:
	$(NODE) scripts/check-syntax.mjs

test:
	$(NODE) scripts/run-node-tests.mjs $(ARGS)

test-exec:
	$(NODE) scripts/run-node-tests.mjs --suite exec $(ARGS)

test-cleanup:
	$(NODE) scripts/run-node-tests.mjs --cleanup-only $(ARGS)

hygiene:
	npm audit --omit=dev --audit-level=moderate

audit-public:
	scripts/audit-public-projection.sh --no-export "."

test-live: test-live-app-server-v2

test-live-app-server-v2: config
	ENV_FILE="$(ENV_FILE)" TELEDEX_ENABLE_APP_SERVER_V2=1 $(NODE) src/cli/run-live-tests.js --app-server-v2 $(ARGS)
