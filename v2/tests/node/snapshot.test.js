import assert from 'node:assert/strict';
import test from 'node:test';
import { SNAPSHOT_SCHEMA_VERSION } from '../../src/sim/constants.js';
import { assertSnapshotCompatibility } from '../../src/sim/snapshot.js';

const expected = { manifestRootHash: 'flat-a', fieldSize: 64, capacity: 512 };
const snapshot = {
  header: { schemaVersion: SNAPSHOT_SCHEMA_VERSION, ...expected },
};

test('snapshot compatibility accepts an exact header and names every mismatch', () => {
  assert.doesNotThrow(() => assertSnapshotCompatibility(snapshot, expected));
  assert.throws(
    () => assertSnapshotCompatibility({
      header: { schemaVersion: 99, manifestRootHash: 'flat-b', fieldSize: 65, capacity: 513 },
    }, expected),
    /schema version, manifest root hash, field size, capacity/,
  );
});
