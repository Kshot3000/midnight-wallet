// This file is part of MIDNIGHT-WALLET-SDK.
// Copyright (C) Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk-abstractions';
import { WalletEntrySchema, mergeWalletEntries } from '@midnightntwrk/wallet-sdk-facade';
import { describe, expect, it } from 'vitest';
import { declaredVersionOf, fixturesFor, type Fixture } from './fixtures.js';

const fixtures = fixturesFor('tx-history');

/** The entries a payload holds, as stored: a `v1` history is a bare array of them, a `v2` one wraps them in an envelope. */
const storedEntries = (fixture: Fixture): readonly Record<string, unknown>[] => {
  const payload: unknown = JSON.parse(fixture.serialized);
  return Array.isArray(payload)
    ? (payload as readonly Record<string, unknown>[])
    : (payload as { readonly entries: readonly Record<string, unknown>[] }).entries;
};

/** A fee as a payload holds it: a value, an explicit `null`, or no `fees` at all. `?? null` would fold the last two. */
const feeAsStored = (entry: Record<string, unknown>): { readonly fee: string | null } | 'absent' => {
  const fee = entry['fees'];
  if (fee === undefined) return 'absent';
  if (fee === null) return { fee: null };
  return { fee: typeof fee === 'bigint' || typeof fee === 'string' ? fee.toString() : JSON.stringify(fee) };
};

describe('transaction histories written by published releases', () => {
  it('should have a fixture to restore', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  describe.each(fixtures)('$id (written by $writtenBy.name $writtenBy.version)', (fixture) => {
    const restore = () =>
      InMemoryTransactionHistoryStorage.restore(fixture.serialized, WalletEntrySchema, mergeWalletEntries);

    it('should restore every entry it was written with, in order', async () => {
      const entries = await restore().getAll();

      expect(entries).toHaveLength(fixture.expected['entryCount'] as number);
      expect(entries.map((entry) => entry.hash)).toEqual(fixture.expected['hashes']);
    });

    it('should preserve the on-chain status of every entry', async () => {
      const entries = await restore().getAll();

      // An entry that has not run yet has no status; the fixture records that absence by name.
      expect(entries.map((entry) => entry.status ?? 'absent')).toEqual(fixture.expected['statuses']);
    });

    it('should preserve the fees of every entry, telling an explicit null from a fee it never recorded', async () => {
      const entries = await restore().getAll();
      const written = storedEntries(fixture);

      // This half compares values only, so a fee never recorded and an explicit `null` both read as `null` here; the
      // half below is the one that tells them apart, against the payload's own bytes.
      const asWritten = (fixture.expected['fees'] as readonly (string | null)[]).map((fee) =>
        fee === null || fee === 'absent' ? null : BigInt(fee),
      );
      expect(entries.map((entry) => entry.fees ?? null)).toEqual(asWritten);
      expect(entries.map(feeAsStored)).toEqual(written.map(feeAsStored));
    });

    it('should keep the identifiers it has and default the ones it never had to empty', async () => {
      const entries = await restore().getAll();

      expect(entries.map((entry) => entry.identifiers.length > 0)).toEqual(fixture.expected['identifiersPresent']);
    });
  });
});

describe('transaction histories written before entries carried a lifecycle', () => {
  // Every entry in these payloads was written from the sync path, after the indexer returned the transaction inside
  // a block. `finalized` is therefore the only honest lifecycle, whatever the entry's `status` — a FAILURE reached a
  // block too, it just failed once it ran.
  describe.each(fixtures.filter((fixture) => declaredVersionOf(fixture.serialized) === 'v1'))('$id', (fixture) => {
    it('should give every entry a finalized lifecycle, whatever its status', async () => {
      const entries = await InMemoryTransactionHistoryStorage.restore(
        fixture.serialized,
        WalletEntrySchema,
        mergeWalletEntries,
      ).getAll();

      expect(entries.map((entry) => entry.lifecycle.status)).toEqual(entries.map(() => 'finalized'));
    });
  });
});

describe('transaction histories written with a lifecycle on every entry', () => {
  const withLifecycles = fixtures.filter((fixture) => declaredVersionOf(fixture.serialized) !== 'v1');

  describe.each(withLifecycles)('$id', (fixture) => {
    const restore = () =>
      InMemoryTransactionHistoryStorage.restore(fixture.serialized, WalletEntrySchema, mergeWalletEntries).getAll();

    // The upgrade from `v1` fills a lifecycle in only where one is missing. A payload that already carries one must
    // keep it: a pending entry read back as finalized would show a transaction as landed that never reached a block.
    it('should keep the lifecycle every entry was written with', async () => {
      const entries = await restore();

      expect(entries.map((entry) => entry.lifecycle.status)).toEqual(fixture.expected['lifecycles']);
    });

    // The status alone would pass a reader that kept the tag and lost the record behind it: the block a transaction
    // landed in, when it was submitted, why it was rejected.
    it('should keep everything each lifecycle recorded, byte for byte', async () => {
      const entries = await restore();

      expect(JSON.parse(JSON.stringify(entries.map((entry) => entry.lifecycle)))).toEqual(
        storedEntries(fixture).map((entry) => entry['lifecycle']),
      );
    });
  });
});
