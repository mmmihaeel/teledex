import test from "node:test";
import assert from "node:assert/strict";

import { normalizeRsyncLocalPath } from "../src/hosts/host-command-runner.js";

test("normalizeRsyncLocalPath converts Windows drive paths for local rsync operands", () => {
  assert.equal(
    normalizeRsyncLocalPath("C:\\Users\\example\\workspace\\", { platform: "win32" }),
    "/c/Users/example/workspace/",
  );
  assert.equal(
    normalizeRsyncLocalPath("D:/state/file.png", { platform: "win32" }),
    "/d/state/file.png",
  );
  assert.equal(
    normalizeRsyncLocalPath("E:\\", { platform: "win32" }),
    "/e/",
  );
});

test("normalizeRsyncLocalPath normalizes non-drive Windows paths without touching Linux", () => {
  assert.equal(
    normalizeRsyncLocalPath("\\tmp\\gateway\\file.txt", { platform: "win32" }),
    "/tmp/gateway/file.txt",
  );
  assert.equal(
    normalizeRsyncLocalPath("/path/to/workspace/", { platform: "linux" }),
    "/path/to/workspace/",
  );
});
