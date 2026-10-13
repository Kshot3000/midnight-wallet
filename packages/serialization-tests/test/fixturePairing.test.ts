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
import { ProtocolVersion } from '@midnightntwrk/wallet-sdk-abstractions';
import { describe, expect, it } from 'vitest';
import { SURFACES, fixturesFor, isHandedTo } from './fixtures.js';

/**
 * Which reader gets handed which payload, asserted now rather than when it first matters.
 *
 * `isHandedTo` keeps the V1 reader away from the payloads the ledger-v9 train wrote from the fork — a shape routing
 * would never give it — and hands every other payload to both readers. The rule is pinned here against payloads built
 * for the purpose, and the corpus below against the frozen fixtures it actually holds.
 */

const forkVersion = ProtocolVersion.V9NativeForkVersion;

/** A snapshot declaring a protocol version, which is all `isHandedTo` reads of it. */
const snapshotAt = (protocolVersion: bigint | undefined): string =>
  JSON.stringify(
    protocolVersion === undefined ? { networkId: 'undeployed' } : { protocolVersion: String(protocolVersion) },
  );

const belowTheFork = snapshotAt(forkVersion - 1n);
const atTheFork = snapshotAt(forkVersion);
const pastTheFork = snapshotAt(forkVersion + 1_000n);
const noVersionAtAll = snapshotAt(undefined);

describe('which reader a stored snapshot could be handed', () => {
  it('gives the V1 reader a payload written below the fork', () => {
    expect(isHandedTo('v1', 'shielded', belowTheFork)).toBe(true);
  });

  // The combination the preservation gates must not generate: routing sends a payload written from the fork to the
  // V2 variant, and no single-variant build is composed of V1, so nothing ever hands this to the V1 reader.
  it('keeps the V1 reader away from a payload written at or past the fork', () => {
    expect(isHandedTo('v1', 'shielded', atTheFork)).toBe(false);
    expect(isHandedTo('v1', 'shielded', pastTheFork)).toBe(false);
  });

  // The V2 reader takes everything, which is the reason these checks run per writer at all: a build registering only
  // the V2 variant has nothing else to open a V1-written snapshot with.
  it('gives the V2 reader every payload, whichever side of the fork wrote it', () => {
    expect(isHandedTo('v2', 'shielded', belowTheFork)).toBe(true);
    expect(isHandedTo('v2', 'shielded', pastTheFork)).toBe(true);
  });

  it('treats a payload that declares no protocol version as written below the fork', () => {
    expect(isHandedTo('v1', 'shielded', noVersionAtAll)).toBe(true);
  });

  it('applies the same rule to every routed snapshot surface', () => {
    expect(
      (['shielded', 'unshielded', 'dust'] as const).map((surface) => isHandedTo('v1', surface, pastTheFork)),
    ).toEqual([false, false, false]);
  });

  // The two surfaces with a single writer outside the twins are not routed by protocol version at all, and are read
  // the same way whichever writer a case is filed under.
  it('hands the unrouted surfaces to both readers regardless', () => {
    expect(isHandedTo('v1', 'tx-history', pastTheFork)).toBe(true);
    expect(isHandedTo('v1', 'pending-transactions', pastTheFork)).toBe(true);
  });
});

describe('the corpus as it stands today', () => {
  // States exactly which payloads the V1 reader is kept away from: the ones the ledger-v9 train wrote from the fork.
  // Listing them rather than counting them means a fixture added past the fork, or one wrongly read as past it, changes
  // this list and has to be looked at — the moment to check that the gates still cover what they should.
  it('keeps the V1 reader away from the payloads written past the fork, and from nothing else', () => {
    const skipped = SURFACES.flatMap((surface) =>
      fixturesFor(surface)
        .filter((fixture) => !isHandedTo('v1', surface, fixture.serialized))
        .map((fixture) => fixture.id),
    );

    expect(skipped).toEqual([
      'shielded/v1/facade-5.0.0-rc.1-v2-deep',
      'shielded/v1/facade-5.0.0-rc.1-v2-pending',
      'shielded/v1/facade-5.0.0-rc.1-v2-receiver',
      'shielded/v1/facade-5.0.0-rc.1-v2',
      'unshielded/v2/facade-5.0.0-rc.1-minimal',
      'unshielded/v2/facade-5.0.0-rc.1',
      'dust/v1/facade-5.0.0-rc.1-v2',
    ]);
  });
});
