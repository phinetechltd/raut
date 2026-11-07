import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isDatabaseBusy, withLockWait } from "./db-url";

describe("withLockWait", () => {
  it("adds the wait to a SQLite address", () => {
    assert.equal(withLockWait("file:./xos.db"), "file:./xos.db?socket_timeout=30");
  });

  it("keeps the options already there", () => {
    assert.equal(withLockWait("file:/tmp/a.db?connection_limit=1"), "file:/tmp/a.db?connection_limit=1&socket_timeout=30");
  });

  it("respects a wait set in the environment", () => {
    assert.equal(withLockWait("file:./xos.db?socket_timeout=60"), "file:./xos.db?socket_timeout=60");
  });

  it("leaves other databases and a missing address alone", () => {
    assert.equal(withLockWait("postgresql://host/raut"), "postgresql://host/raut");
    assert.equal(withLockWait(undefined), undefined);
    assert.equal(withLockWait(""), "");
  });
});

describe("isDatabaseBusy", () => {
  it("recognises a lock or transaction timeout", () => {
    for (const code of ["P1008", "P2024", "P2028", "P2034"]) {
      assert.equal(isDatabaseBusy(Object.assign(new Error("x"), { code })), true, code);
    }
  });

  it("does not hide other failures behind try again", () => {
    assert.equal(isDatabaseBusy(Object.assign(new Error("x"), { code: "P2002" })), false);
    assert.equal(isDatabaseBusy(new Error("Socket timeout")), false);
    assert.equal(isDatabaseBusy(null), false);
    assert.equal(isDatabaseBusy("P1008"), false);
  });
});
