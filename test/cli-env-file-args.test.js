import test from "node:test";
import assert from "node:assert/strict";

import { applyEnvFileArg, parseEnvFileArg } from "../src/cli/env-file-args.js";

test("parseEnvFileArg extracts --env-file and keeps other args", () => {
  assert.deepEqual(
    parseEnvFileArg(["--env-file", "/tmp/teledex.env", "--once"]),
    { envFilePath: "/tmp/teledex.env", rest: ["--once"] },
  );
  assert.deepEqual(
    parseEnvFileArg(["--env-file=/tmp/teledex.env"]),
    { envFilePath: "/tmp/teledex.env", rest: [] },
  );
});

test("parseEnvFileArg rejects missing env file paths", () => {
  assert.throws(() => parseEnvFileArg(["--env-file"]), /requires a path/u);
  assert.throws(() => parseEnvFileArg(["--env-file="]), /requires a path/u);
});

test("applyEnvFileArg updates ENV_FILE in the provided environment", () => {
  const env = {};
  const parsed = applyEnvFileArg(["--env-file", "/tmp/teledex.env"], env);

  assert.equal(parsed.envFilePath, "/tmp/teledex.env");
  assert.equal(env.ENV_FILE, "/tmp/teledex.env");
});
