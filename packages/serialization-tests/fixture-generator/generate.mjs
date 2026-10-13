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

// Generates the committed fixtures under ../fixtures/ by serializing wallet content with the real
// published SDK versions (npm aliases in package.json, ledgers pinned per train via overrides).
//
// Run: npm ci && node generate.mjs
//
// Wallet states are produced by EVENT REPLAY through each train's own sync path (see
// chainDriver.mjs), so fixtures hold exactly what a synced production wallet held. Every fixture
// is self-checked: the version that wrote it must be able to read it back, or generation fails.
//
// Fixture set per train:
//   shielded.json            sender wallet after mint + confirmed outgoing transfer
//                            (T1 additionally embeds two mock-proven txs in its snapshot history)
//   shielded-receiver.json   receiver wallet holding the incoming transfer
//   shielded-pending.json    sender wallet with an unconfirmed local spend (pending coins)
//   shielded-deep.json       sender after many interleaved mint/spend rounds (deep, gappy tree)
//   unshielded.json          night (registered for dust generation) + custom token + pending UTXO
//   unshielded-minimal.json  optional fields absent (no appliedId, empty pending)
//   dust.json                dust wallet with a real generated dust UTXO (registration + claim)
//   tx-history.json          (T4/T6) storage payload exercising every field shape the era's
//                            schema allowed, using the facade's app-level WalletEntrySchema
//   pending-transactions.json (T2+) PendingTransactions payload with mock-proven ledger txs —
//                            the wire schema is versioned and stable, but the embedded tx blobs
//                            cross the ledger v7→v8 boundary
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  ledgerFor,
  ledgerNameOf,
  runScenario,
  SEEDS,
  TOKEN_A,
  TOKEN_B,
  MINT_A_VALUES,
  MINT_B_VALUE,
  TRANSFER_VALUE,
  NIGHT_VALUE,
  CUSTOM_UNSHIELDED,
  CUSTOM_UNSHIELDED_VALUE,
} from './chainDriver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');

const loadDist = (alias, file) => import(pathToFileURL(path.join(HERE, 'node_modules', alias, 'dist', file)));

const pkgMeta = (alias) => {
  const pkgJson = JSON.parse(readFileSync(path.join(HERE, 'node_modules', alias, 'package.json'), 'utf8'));
  const ledgerName = ledgerNameOf(pkgJson);
  const ledgerDep = ledgerName === undefined ? undefined : `${ledgerName}@${pkgJson.dependencies[ledgerName]}`;
  return { name: pkgJson.name, version: pkgJson.version, ledgerDep };
};

const unwrap = (v, what) => {
  if (v && v._tag === 'Left') throw new Error(`${what} failed: ${JSON.stringify(v.left).slice(0, 300)}`);
  return v && v._tag === 'Right' ? v.right : v;
};

const selfCheck = (what, result) => {
  const value = unwrap(result, `${what} self-check`);
  if (value === undefined || value === null) throw new Error(`${what} self-check returned ${value}`);
  return value;
};

const writeFixture = (train, name, data) => {
  const dir = path.join(FIXTURES, train);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
  console.log(`  wrote ${train}/${name}.json`);
};

const FIXED_DATE = new Date('2026-03-01T12:00:00.000Z');
const NETWORK_ID = 'undeployed';

// Scenario event bytes are portable across wasm module instances (each consumer deserializes with
// its own ledger), so one scenario run per train serves all three wallet packages.
const scenarioCache = new Map();
const scenarioFor = async (shieldedAlias, deep = false) => {
  const key = `${shieldedAlias}:${deep}`;
  const cached = scenarioCache.get(key);
  if (cached !== undefined) return cached;
  const L = await ledgerFor(shieldedAlias);
  const result = { L, scenario: runScenario(L, { deep }) };
  scenarioCache.set(key, result);
  return result;
};

// --- shielded ----------------------------------------------------------------------------------
// `variant` picks which of a train's twin trees writes the snapshot. A train on ledger-v9 is written by its V2 variant,
// whose sync stamps the protocol version the chain reports; `protocolVersion` is that version. Without it a V2 snapshot
// would declare the variant's floor, which routing hands to the V1 reader — so it would not be the shape under test.
const generateShieldedSet = async (train, alias, { family, variant = 'v1', protocolVersion }) => {
  const L = await ledgerFor(alias);
  const { CoreWallet } = await loadDist(alias, `${variant}/CoreWallet.js`);
  const Ser = await loadDist(alias, `${variant}/Serialization.js`);
  const capability =
    variant === 'v2' ? Ser.makeDefaultV2SerializationCapability() : Ser.makeDefaultV1SerializationCapability();
  const stamp = (wallet) =>
    protocolVersion === undefined ? wallet : CoreWallet.withProtocolVersion(wallet, protocolVersion);
  const { scenario } = await scenarioFor(alias, false);

  const replay = (wallet, keys, eventBytes) => {
    const events = eventBytes.map((b) => L.Event.deserialize(b));
    return family === 'withChanges'
      ? CoreWallet.replayEventsWithChanges(wallet, keys, events)[0]
      : CoreWallet.replayEvents(wallet, keys, events);
  };

  const senderKeys = L.ZswapSecretKeys.fromSeed(SEEDS.shieldedSender);
  const receiverKeys = L.ZswapSecretKeys.fromSeed(SEEDS.shieldedReceiver);

  const progress = (wallet) =>
    stamp(
      CoreWallet.updateProgress(wallet, {
        appliedIndex: BigInt(scenario.allEventBytes.length),
        highestRelevantWalletIndex: BigInt(scenario.allEventBytes.length),
        highestIndex: BigInt(scenario.allEventBytes.length),
        highestRelevantIndex: BigInt(scenario.allEventBytes.length),
        isConnected: false,
      }),
    );

  const senderSynced = progress(
    replay(CoreWallet.initEmpty(senderKeys, NETWORK_ID), senderKeys, scenario.allEventBytes),
  );
  const receiverSynced = progress(
    replay(CoreWallet.initEmpty(receiverKeys, NETWORK_ID), receiverKeys, scenario.allEventBytes),
  );

  // T1 embedded tx history: fully proven (mockProve) txs, accepted by T1's own deserializer.
  const mkHistoryTx = (value) => {
    const coin = L.createShieldedCoinInfo(TOKEN_A, value);
    const output = L.ZswapOutput.new(coin, 0, senderKeys.coinPublicKey, senderKeys.encryptionPublicKey);
    const offer = L.ZswapOffer.fromOutput(output, TOKEN_A, value);
    return L.Transaction.fromParts(NETWORK_ID, offer).mockProve();
  };
  const sender =
    family === 'embeddedHistory'
      ? [1n, 2n].reduce((w, v) => unwrap(CoreWallet.addTransaction(w, mkHistoryTx(v)), 'addTransaction'), senderSynced)
      : senderSynced;

  const senderCoinValues = { [TOKEN_A]: [100n, 250n - TRANSFER_VALUE, 400n], [TOKEN_B]: [MINT_B_VALUE] };
  const emit = (name, wallet, expected) => {
    const serialized = capability.serialize(wallet);
    selfCheck(`${alias} ${name}`, capability.deserialize(null, serialized));
    writeFixture(train, name, {
      train,
      ...pkgMeta(alias),
      generatedWith: { scenario: 'chainDriver event replay', seeds: 'fill(7)/fill(8)/fill(9)/fill(21)' },
      snapshotFields: Object.keys(JSON.parse(serialized)),
      expected,
      serialized,
    });
  };

  emit('shielded', sender, {
    networkId: NETWORK_ID,
    tokenA: TOKEN_A,
    tokenB: TOKEN_B,
    coinValuesA: senderCoinValues[TOKEN_A].map(String),
    coinValuesB: senderCoinValues[TOKEN_B].map(String),
    balanceA: String(senderCoinValues[TOKEN_A].reduce((a, b) => a + b, 0n)),
    balanceB: String(MINT_B_VALUE),
    embeddedTxHistoryCount: family === 'embeddedHistory' ? 2 : 0,
  });

  emit('shielded-receiver', receiverSynced, {
    networkId: NETWORK_ID,
    tokenA: TOKEN_A,
    coinValuesA: [String(TRANSFER_VALUE)],
    balanceA: String(TRANSFER_VALUE),
  });

  // Pending local spend: spendCoins marks coins pending inside the ZswapLocalState, exactly the
  // state an app persists between submitting a tx and seeing it confirmed.
  const coinToSpend = [...senderSynced.state.coins].find((c) => c.type === TOKEN_A && c.value === 400n);
  if (coinToSpend === undefined) throw new Error(`${alias}: 400n coin not found for pending fixture`);
  const [, senderPending] = CoreWallet.spendCoins(senderSynced, senderKeys, [coinToSpend], 0);
  emit('shielded-pending', senderPending, {
    networkId: NETWORK_ID,
    tokenA: TOKEN_A,
    availableValuesA: [String(100n), String(250n - TRANSFER_VALUE)],
    pendingSpendCount: 1,
    balanceB: String(MINT_B_VALUE),
  });

  // Deep tree: many interleaved mints and confirmed spends → gappy commitment tree.
  const { scenario: deepScenario } = await scenarioFor(alias, true);
  const deepSender = stamp(
    replay(CoreWallet.initEmpty(senderKeys, NETWORK_ID), senderKeys, deepScenario.allEventBytes),
  );
  const deepCoinCount = deepSender.state.coins.size;
  const deepFirstFree = String(deepSender.state.firstFree);
  emit('shielded-deep', deepSender, {
    networkId: NETWORK_ID,
    coinCount: deepCoinCount,
    firstFree: deepFirstFree,
  });
};

// --- unshielded --------------------------------------------------------------------------------
const generateUnshieldedSet = async (train, alias) => {
  const L = await ledgerFor(alias);
  const { UnshieldedState, UtxoWithMeta } = await loadDist(alias, 'v1/UnshieldedState.js');
  const Ser = await loadDist(alias, 'v1/Serialization.js');
  const capability = Ser.makeDefaultV1SerializationCapability();
  // A real key, derived by the train's own keystore from a fixed seed, so the address in the snapshot is the one this
  // key actually produces. A reader that checks the address against the key — as newer SDKs do at the deserialization
  // trust boundary — must accept what a real wallet of this version wrote.
  const KeyStore = await loadDist(alias, 'KeyStore.js');
  const publicKey = KeyStore.PublicKey.fromKeyStore(KeyStore.createKeystore(SEEDS.nightBip340, NETWORK_ID));

  const nightToken = typeof L.nativeToken === 'function' ? (L.nativeToken().raw ?? L.nativeToken()) : '00'.repeat(32);
  const mkUtxo = (value, type, outputNo, intentHashByte, registered) =>
    new UtxoWithMeta({
      utxo: {
        value,
        owner: publicKey.addressHex,
        type,
        intentHash: String(intentHashByte).padStart(2, '0').repeat(32),
        outputNo,
      },
      meta: { ctime: FIXED_DATE, registeredForDustGeneration: registered },
    });

  const nightUtxo = mkUtxo(NIGHT_VALUE, nightToken, 0, 55, true);
  const customUtxo = mkUtxo(CUSTOM_UNSHIELDED_VALUE, CUSTOM_UNSHIELDED, 1, 56, false);
  const pendingUtxo = mkUtxo(4200n, CUSTOM_UNSHIELDED, 0, 57, false);

  const emit = (name, wallet, expected) => {
    const serialized = capability.serialize(wallet);
    selfCheck(`${alias} ${name}`, capability.deserialize(serialized));
    writeFixture(train, name, {
      train,
      ...pkgMeta(alias),
      generatedWith: { fixedDate: FIXED_DATE.toISOString() },
      snapshotFields: Object.keys(JSON.parse(serialized)),
      expected,
      serialized,
    });
  };

  emit(
    'unshielded',
    {
      publicKey,
      state: UnshieldedState.restore([nightUtxo, customUtxo], [pendingUtxo]),
      protocolVersion: 1n,
      networkId: NETWORK_ID,
      progress: { appliedId: 5n, highestTransactionId: 5n },
    },
    {
      networkId: NETWORK_ID,
      nightToken,
      customToken: CUSTOM_UNSHIELDED,
      availableValues: [String(NIGHT_VALUE), String(CUSTOM_UNSHIELDED_VALUE)],
      pendingValues: ['4200'],
      registeredFlags: [true, false],
      appliedId: '5',
      address: publicKey.address,
    },
  );

  emit(
    'unshielded-minimal',
    {
      publicKey,
      state: UnshieldedState.restore([customUtxo], []),
      protocolVersion: 1n,
      networkId: NETWORK_ID,
      progress: undefined,
    },
    {
      networkId: NETWORK_ID,
      availableValues: [String(CUSTOM_UNSHIELDED_VALUE)],
      pendingValues: [],
      appliedId: undefined,
    },
  );
};

// The V2 variant's unshielded wallet, which differs from the V1 one in every step that builds it: its key is derived
// from a secret tagged with its signature kind, a booked coin carries the expiry of the transaction it was booked for,
// and the wallet is assembled by `CoreWallet` rather than as a bare object. The snapshot it writes is the `v2` format.
const generateUnshieldedSetV2 = async (train, alias, { protocolVersion }) => {
  const L = await ledgerFor(alias);
  const { UnshieldedState, UtxoWithMeta } = await loadDist(alias, 'v2/UnshieldedState.js');
  const { CoreWallet } = await loadDist(alias, 'v2/CoreWallet.js');
  const Ser = await loadDist(alias, 'v2/Serialization.js');
  const capability = Ser.makeDefaultV2SerializationCapability();
  const KeyStore = await loadDist(alias, 'KeyStore.js');
  const publicKey = KeyStore.PublicKey.fromKeyStore(
    KeyStore.createKeystore({ kind: 'schnorr', secret: SEEDS.nightBip340 }, NETWORK_ID),
  );

  const nightToken = L.nativeToken().raw ?? L.nativeToken();
  const mkUtxo = (value, type, outputNo, intentHashByte, registered) =>
    new UtxoWithMeta({
      utxo: {
        value,
        owner: publicKey.addressHex,
        type,
        intentHash: String(intentHashByte).padStart(2, '0').repeat(32),
        outputNo,
      },
      meta: { ctime: FIXED_DATE, registeredForDustGeneration: registered },
    });

  const nightUtxo = mkUtxo(NIGHT_VALUE, nightToken, 0, 55, true);
  const customUtxo = mkUtxo(CUSTOM_UNSHIELDED_VALUE, CUSTOM_UNSHIELDED, 1, 56, false);
  const pendingUtxo = mkUtxo(4200n, CUSTOM_UNSHIELDED, 0, 57, false);
  // A booking that is still live whenever the fixture is read, so a restore keeps it on the pending side. A real
  // transaction's TTL is hours, which would have every later read release the coin and leave the pending side of the
  // snapshot untested.
  const BOOKING_TTL = new Date('2100-01-01T00:00:00.000Z');

  const emit = (name, wallet, expected) => {
    const serialized = capability.serialize(wallet);
    selfCheck(`${alias} ${name}`, capability.deserialize(serialized));
    writeFixture(train, name, {
      train,
      ...pkgMeta(alias),
      generatedWith: {
        fixedDate: FIXED_DATE.toISOString(),
        bookingTtl: BOOKING_TTL.toISOString(),
        protocolVersion: String(protocolVersion),
      },
      snapshotFields: Object.keys(JSON.parse(serialized)),
      expected,
      serialized,
    });
  };

  emit(
    'unshielded',
    CoreWallet.restore(
      UnshieldedState.restore([nightUtxo, customUtxo], [{ utxo: pendingUtxo, ttl: BOOKING_TTL }]),
      publicKey,
      { appliedId: 5n, highestTransactionId: 5n },
      protocolVersion,
      NETWORK_ID,
    ),
    {
      networkId: NETWORK_ID,
      nightToken,
      customToken: CUSTOM_UNSHIELDED,
      availableValues: [String(NIGHT_VALUE), String(CUSTOM_UNSHIELDED_VALUE)],
      pendingValues: ['4200'],
      registeredFlags: [true, false],
      appliedId: '5',
      address: publicKey.address,
    },
  );

  // A wallet that has synced past the fork without ever recording a transaction id: the V2 variant starts from an
  // empty progress rather than none, so `appliedId` is written as zero instead of being left out.
  const minimal = CoreWallet.withProtocolVersion(
    CoreWallet.withState(CoreWallet.init(publicKey, NETWORK_ID), UnshieldedState.restore([customUtxo], [])),
    protocolVersion,
  );
  emit('unshielded-minimal', minimal, {
    networkId: NETWORK_ID,
    availableValues: [String(CUSTOM_UNSHIELDED_VALUE)],
    pendingValues: [],
    appliedId: String(minimal.progress.appliedId),
  });
};

// --- dust ---------------------------------------------------------------------------------------
// `variant` and `protocolVersion` as for the shielded set. The scenario registers for Dust and claims Night on the
// train's own ledger, so a ledger-v9 train's Dust is generated on ledger-v9 — as it must be, since the v9 fork resets
// Dust state rather than carrying it.
const generateDust = async (train, alias, shAlias, { flatDist = false, variant = 'v1', protocolVersion } = {}) => {
  const L = await ledgerFor(alias);
  const prefix = flatDist ? '' : `${variant}/`;
  const CW = await loadDist(alias, `${prefix}${flatDist ? 'DustCoreWallet' : 'CoreWallet'}.js`);
  const CoreWallet = flatDist ? CW.DustCoreWallet : CW.CoreWallet;
  const Ser = await loadDist(alias, `${prefix}Serialization.js`);
  const capability =
    variant === 'v2' ? Ser.makeDefaultV2SerializationCapability() : Ser.makeDefaultV1SerializationCapability();
  // Shielded alias passed explicitly (see generateUnshieldedSet) — the scenario uses its ledger.
  const { scenario } = await scenarioFor(shAlias, false);

  const dustKey = L.DustSecretKey.fromSeed(SEEDS.dust);
  const params = L.LedgerParameters.initialParameters().dust;
  const events = scenario.allEventBytes.map((b) => L.Event.deserialize(b));
  const empty = CoreWallet.initEmpty(params, dustKey, NETWORK_ID);
  // Sync-path drift across trains: T1 has an instance-method applyEvents on a class; T2/T3 a
  // static applyEvents; T4/T6 applyEventsWithChanges returning [wallet, changes].
  const replayed = flatDist
    ? empty.applyEvents(dustKey, events, scenario.finalTime)
    : typeof CoreWallet.applyEvents === 'function'
      ? CoreWallet.applyEvents(empty, dustKey, events, scenario.finalTime)
      : CoreWallet.applyEventsWithChanges(empty, dustKey, events, scenario.finalTime)[0];
  const synced = protocolVersion === undefined ? replayed : CoreWallet.withProtocolVersion(replayed, protocolVersion);

  const utxoCount = synced.state.utxos.length;
  if (utxoCount !== 1) throw new Error(`${alias}: expected 1 generated dust UTXO, got ${utxoCount}`);

  const serialized = capability.serialize(synced);
  selfCheck(`${alias} dust`, capability.deserialize(null, serialized));
  writeFixture(train, 'dust', {
    train,
    ...pkgMeta(alias),
    generatedWith: { scenario: 'chainDriver: dust registration then night claim' },
    snapshotFields: Object.keys(JSON.parse(serialized)),
    expected: {
      networkId: NETWORK_ID,
      publicKey: String(dustKey.publicKey),
      dustUtxoCount: 1,
      backingNightValue: String(NIGHT_VALUE),
    },
    serialized,
  });
};

// --- tx history (abstractions storage via the facade's app-level schema) -------------------------
const generateTxHistory = async (train, absAlias, faAlias) => {
  const abs = await loadDist(absAlias, 'index.js');
  const fa = await loadDist(faAlias, 'index.js');
  const storage = new abs.InMemoryTransactionHistoryStorage(fa.WalletEntrySchema, fa.mergeWalletEntries);

  // Every field shape the T4-era WalletEntrySchema allowed, across all three wallet sections.
  // Notably `identifiers` was OPTIONAL then (entry 3 omits it) but is REQUIRED by the current
  // schema — a second break axis besides `lifecycle`.
  const entries = [
    {
      hash: 'c0'.repeat(32),
      protocolVersion: 1,
      status: 'SUCCESS',
      identifiers: ['identifier-1', 'identifier-2'],
      timestamp: FIXED_DATE,
      fees: 1234n,
      shielded: {
        receivedCoins: [{ type: TOKEN_A, nonce: 'ab'.repeat(32), value: 100n, mtIndex: 0n }],
        spentCoins: [{ type: TOKEN_A, nonce: 'cd'.repeat(32), value: 250n, mtIndex: 1n }],
      },
    },
    {
      hash: 'd1'.repeat(32),
      protocolVersion: 1,
      status: 'FAILURE',
      identifiers: ['identifier-3'],
      timestamp: FIXED_DATE,
      fees: null,
      unshielded: {
        id: 7,
        createdUtxos: [
          {
            value: 1000n,
            owner: 'owner-address',
            tokenType: CUSTOM_UNSHIELDED,
            intentHash: '55'.repeat(32),
            outputIndex: 0,
          },
        ],
        spentUtxos: [],
      },
    },
    {
      hash: 'e2'.repeat(32),
      protocolVersion: 1,
      status: 'PARTIAL_SUCCESS',
      // identifiers intentionally absent — legal at T4, required by the current schema
      dust: {
        receivedUtxos: [{ initialValue: 0n, nonce: 42n, seq: 0, backingNight: '66'.repeat(32), mtIndex: 0n }],
        spentUtxos: [],
      },
    },
  ];
  for (const entry of entries) {
    await storage.upsert(entry);
  }
  const serialized = await storage.serialize();

  const restored = abs.InMemoryTransactionHistoryStorage.restore(serialized, fa.WalletEntrySchema);
  const restoredEntries = await restored.getAll();
  if (restoredEntries.length !== entries.length) {
    throw new Error(`${absAlias} tx-history self-check: expected ${entries.length}, got ${restoredEntries.length}`);
  }
  console.log(`  self-check OK: ${absAlias} tx-history (${restoredEntries.length} entries)`);

  writeFixture(train, 'tx-history', {
    train,
    ...pkgMeta(absAlias),
    schemaFrom: pkgMeta(faAlias),
    expected: {
      entryCount: entries.length,
      hashes: entries.map((e) => e.hash),
      statuses: entries.map((e) => e.status),
      fees: [String(1234n), null, undefined],
      identifiersPresent: [true, true, false],
    },
    serialized,
  });
};

// The `v2` history, as the 5.0 train writes it: an envelope around entries that each carry a lifecycle. Entries go in
// through the three lifecycle writers that release introduced, so the payload holds every lifecycle a 5.0 wallet can
// store — not only `finalized`, the one lifecycle a `v1` history could ever hold.
const generateTxHistoryV2 = async (train, absAlias, faAlias) => {
  const abs = await loadDist(absAlias, 'index.js');
  const fa = await loadDist(faAlias, 'index.js');
  const storage = new abs.InMemoryTransactionHistoryStorage(fa.WalletEntrySchema, fa.mergeWalletEntries);

  const finalizedBlock = { hash: 'f0'.repeat(32), height: 4321, timestamp: FIXED_DATE };
  const writes = [
    {
      lifecycle: 'finalized',
      write: (entry) => storage.gotFinalized({ ...entry, finalizedBlock }),
      entry: {
        hash: 'c0'.repeat(32),
        protocolVersion: 1,
        status: 'SUCCESS',
        identifiers: ['identifier-1', 'identifier-2'],
        timestamp: FIXED_DATE,
        fees: 1234n,
        shielded: {
          receivedCoins: [{ type: TOKEN_A, nonce: 'ab'.repeat(32), value: 100n, mtIndex: 0n }],
          spentCoins: [{ type: TOKEN_A, nonce: 'cd'.repeat(32), value: 250n, mtIndex: 1n }],
        },
      },
    },
    {
      lifecycle: 'finalized',
      write: (entry) => storage.gotFinalized({ ...entry, finalizedBlock }),
      entry: {
        hash: 'd1'.repeat(32),
        protocolVersion: 1,
        status: 'FAILURE',
        identifiers: ['identifier-3'],
        timestamp: FIXED_DATE,
        fees: null,
        unshielded: {
          id: 7,
          createdUtxos: [
            {
              value: 1000n,
              owner: 'owner-address',
              tokenType: CUSTOM_UNSHIELDED,
              intentHash: '55'.repeat(32),
              outputIndex: 0,
            },
          ],
          spentUtxos: [],
        },
      },
    },
    {
      lifecycle: 'pending',
      write: (entry) => storage.gotPending({ ...entry, submittedAt: FIXED_DATE }),
      entry: {
        hash: 'e2'.repeat(32),
        identifiers: ['identifier-4'],
        dust: {
          receivedUtxos: [{ initialValue: 0n, nonce: 42n, seq: 0, backingNight: '66'.repeat(32), mtIndex: 0n }],
          spentUtxos: [],
        },
      },
    },
    {
      lifecycle: 'rejected',
      write: (entry) => storage.gotRejected({ ...entry, rejectedAt: FIXED_DATE, reason: 'fixture: rejected by node' }),
      entry: { hash: 'f3'.repeat(32), identifiers: ['identifier-5'] },
    },
  ];
  for (const { write, entry } of writes) {
    await write(entry);
  }
  const serialized = await storage.serialize();

  const restored = await abs.InMemoryTransactionHistoryStorage.restore(
    serialized,
    fa.WalletEntrySchema,
    fa.mergeWalletEntries,
  ).getAll();
  const lifecycles = restored.map((entry) => entry.lifecycle.status);
  if (JSON.stringify(lifecycles) !== JSON.stringify(writes.map((w) => w.lifecycle))) {
    throw new Error(`${absAlias} tx-history self-check: lifecycles came back as ${JSON.stringify(lifecycles)}`);
  }
  console.log(`  self-check OK: ${absAlias} tx-history (${restored.length} entries)`);

  writeFixture(train, 'tx-history', {
    train,
    ...pkgMeta(absAlias),
    schemaFrom: pkgMeta(faAlias),
    expected: {
      entryCount: writes.length,
      hashes: writes.map((w) => w.entry.hash),
      // A pending or rejected entry has not run, so it has no status and no fee. JSON cannot hold `undefined` in an
      // array — it writes `null` — so their absence is recorded by name, apart from the explicit `null` fee of the
      // second entry.
      statuses: writes.map((w) => w.entry.status ?? 'absent'),
      fees: writes.map((w) =>
        w.entry.fees === undefined ? 'absent' : w.entry.fees === null ? null : String(w.entry.fees),
      ),
      identifiersPresent: [true, true, true, true],
      lifecycles: writes.map((w) => w.lifecycle),
    },
    serialized,
  });
};

// --- pending transactions (capabilities layer, exists from T2 on) --------------------------------
// The wire schema ({version:'v1', transactions:[{tx: hex, creationTime}]}) is stable across every
// era, but `tx` holds serialized ledger Transactions written by the era's ledger — proven
// transactions (mockProve stands in for real proofs) crossing the v7→v8 boundary on upgrade.
const generatePendingTransactions = async (train, capAlias, shAlias) => {
  const L = await ledgerFor(shAlias); // era ledger, exact pinned version
  const PT = await loadDist(capAlias, 'pendingTransactions/pendingTransactions.js');
  // Use the capability package's own effect instance for DateTime values it stores.
  const capEffect = await import(
    pathToFileURL(createRequire(path.join(HERE, 'node_modules', capAlias, 'dist', 'index.js')).resolve('effect'))
  );

  // Functionally the facade's finalizedTransactionTrait: proven-transaction markers. The trait
  // interface drifted across eras (isOneIncludedInOther → areAllTxIdsIncluded), so this is a
  // superset — each era calls the methods it knows.
  const txTrait = {
    isTx: (tx) => tx instanceof L.Transaction,
    serialize: (tx) => tx.serialize(),
    deserialize: (bytes) => L.Transaction.deserialize('signature', 'proof', 'binding', bytes),
    ids: (tx) => [...tx.identifiers()],
    firstId: (tx) => tx.identifiers()[0],
    areAllTxIdsIncluded: (tx, txIds) => tx.identifiers().every((id) => txIds.includes(id)),
    isOneIncludedInOther: (a, b) => a.identifiers().some((id) => b.identifiers().includes(id)),
    hasTTLExpired: () => false,
  };

  const senderKeys = L.ZswapSecretKeys.fromSeed(SEEDS.shieldedSender);
  const mkTx = (value) => {
    const coin = L.createShieldedCoinInfo(TOKEN_A, value);
    const output = L.ZswapOutput.new(coin, 0, senderKeys.coinPublicKey, senderKeys.encryptionPublicKey);
    const offer = L.ZswapOffer.fromOutput(output, TOKEN_A, value);
    return L.Transaction.fromParts(NETWORK_ID, offer).mockProve();
  };

  const now = capEffect.DateTime.unsafeMake(FIXED_DATE.getTime());
  const txs = [mkTx(11n), mkTx(22n)];
  const state = txs.reduce((s, tx) => PT.addPendingTransaction(s, tx, now, txTrait), PT.empty());
  const serialized = PT.serialize(state, txTrait);

  const restored = selfCheck(`${capAlias} pending-transactions`, PT.deserialize(serialized, txTrait));
  if (restored.all.length !== txs.length) {
    throw new Error(`${capAlias} pending-transactions self-check: expected ${txs.length}, got ${restored.all.length}`);
  }

  writeFixture(train, 'pending-transactions', {
    train,
    ...pkgMeta(capAlias),
    ledgerUsed: pkgMeta(shAlias).ledgerDep,
    generatedWith: { note: 'mock-proven transactions; trait mirrors the facade finalizedTransactionTrait' },
    expected: {
      txCount: txs.length,
      creationTime: FIXED_DATE.toISOString(),
      identifiers: txs.map((tx) => [...tx.identifiers()]),
    },
    serialized,
  });
};

// --- MPT canonicity sweep: v7-written states must deserialize under v8.0.3 ----------------------
// Targets ledger 8.0.1's "breaking: fix: merkle tree canonicity" (no serialization tag bump). Runs
// deterministic churn (LCG-seeded mint/spend interleavings) plus the deep scenario states, failing
// generation if any v7 state is rejected by v8.
const mptSweep = async () => {
  const L7 = await ledgerFor('sh-2.0.0'); // 7.0.2, exactly what T2 prod apps ran
  const L803 = await ledgerFor('sh-2.1.0'); // 8.0.3, exactly what T3 prod apps ran
  const keys = L7.ZswapSecretKeys.fromSeed(SEEDS.shieldedSender);

  const lcg = (() => {
    let s = 0x12345678;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s;
    };
  })();

  const mkOffer = (tokenByte, value) => {
    const tokenType = String(tokenByte % 10).repeat(64);
    const coin = L7.createShieldedCoinInfo(tokenType, value);
    const output = L7.ZswapOutput.new(coin, 0, keys.coinPublicKey, keys.encryptionPublicKey);
    return L7.ZswapOffer.fromOutput(output, tokenType, value);
  };

  const ROUNDS = 200;
  const failures = [];
  const finalState = Array.from({ length: ROUNDS }, (_, i) => i).reduce((state, round) => {
    const roll = lcg() % 100;
    const next = (() => {
      if (roll < 60 || state.coins.size === 0) {
        return state.apply(keys, mkOffer(lcg() % 10, BigInt(1 + (lcg() % 5000))));
      }
      const coins = [...state.coins];
      const coin = coins[lcg() % coins.length];
      const [afterSpend, input] = state.spend(keys, coin, 0);
      // spend-and-confirm: apply the input so the coin is fully removed (tree churn)
      return afterSpend.apply(keys, L7.ZswapOffer.fromInput(input, coin.type, coin.value));
    })();
    if (round % 10 === 0) {
      const bytes = next.serialize();
      try {
        L803.ZswapLocalState.deserialize(bytes);
      } catch (e) {
        failures.push({ round, error: String(e).slice(0, 200) });
      }
    }
    return next;
  }, new L7.ZswapLocalState());

  const finalBytes = finalState.serialize();
  try {
    const restored = L803.ZswapLocalState.deserialize(finalBytes);
    console.log(
      `  MPT sweep OK: ${ROUNDS} churn rounds, final state (${finalState.coins.size} coins, firstFree ${finalState.firstFree}) deserializes under 8.0.3`,
    );
  } catch (e) {
    failures.push({ round: 'final', error: String(e).slice(0, 200) });
  }
  if (failures.length > 0) {
    throw new Error(`MPT canonicity sweep FAILED: ${JSON.stringify(failures.slice(0, 3))}`);
  }
};

// --- trains --------------------------------------------------------------------------------------
// A train IS a facade version — facade is the source of truth. The `sh`/`un`/`du`/`abs`/`cap`
// aliases below are named by the wallet version they install, and those versions are exactly
// facade@<train>'s declared dependency closure (verified against `npm view <facade>@X dependencies`).
// We still install each wallet package directly (aliased) because the generator drives wallet
// INTERNALS (CoreWallet, Serialization, capabilities) that facade doesn't re-export — facade decides
// the versions, not the imports.
//
// To add a train: `npm view @midnightntwrk/wallet-sdk-facade@<new> dependencies`, then add aliases
// pinned to exactly those versions and a row here keyed by the new facade version.
//
// `abs-2.1.0-new` vs `abs-2.1.0`: abstractions kept version 2.1.0 across the @midnight-ntwrk →
// @midnightntwrk scope rename, so the facade-4.0.0 and facade-4.1.0 abstractions differ ONLY by npm
// scope; the `-new` alias installs the post-rename @midnightntwrk package.
const TRAINS = [
  {
    train: 'facade-1.0.0',
    sh: 'sh-1.0.0',
    un: 'un-1.0.0',
    du: 'du-1.0.0',
    shieldedFamily: 'embeddedHistory',
    dustFlat: true,
  },
  { train: 'facade-2.0.0', sh: 'sh-2.0.0', un: 'un-2.0.0', du: 'du-2.0.0', shieldedFamily: 'plain', cap: 'cap-3.1.0' },
  { train: 'facade-3.0.0', sh: 'sh-2.1.0', un: 'un-2.1.0', du: 'du-3.0.0', shieldedFamily: 'plain', cap: 'cap-3.2.0' },
  {
    train: 'facade-4.0.0',
    sh: 'sh-3.0.0',
    un: 'un-3.0.0',
    du: 'du-4.0.0',
    shieldedFamily: 'withChanges',
    abs: 'abs-2.1.0',
    fa: 'fa-4.0.0',
    cap: 'cap-3.3.0',
  },
  {
    train: 'facade-4.1.0',
    sh: 'sh-3.0.2',
    un: 'un-3.1.0',
    du: 'du-4.2.0',
    shieldedFamily: 'withChanges',
    abs: 'abs-2.1.0-new',
    fa: 'fa-4.1.0',
    cap: 'cap-3.3.1',
  },
  // The first ledger-v9 train, written by its V2 variant. Its pending-transaction format is the `v1` that every train
  // before it froze, so it is not regenerated here.
  {
    train: 'facade-5.0.0-rc.1',
    variant: 'v2',
    sh: 'sh-4.0.0-rc.1',
    un: 'un-4.0.0-rc.1',
    du: 'du-5.0.0-rc.1',
    shieldedFamily: 'withChanges',
    abs: 'abs-3.0.0-rc.1',
    fa: 'fa-5.0.0-rc.1',
  },
];

// ONLY=<surface>[,<surface>] regenerates one surface's fixtures and leaves every other frozen file untouched. Published
// fixtures are a record; nothing here should rewrite one that is not the reason the generator was run.
const only = new Set((process.env['ONLY'] ?? 'shielded,unshielded,dust,tx-history,pending-transactions').split(','));
const wants = (surface) => only.has(surface);
// TRAIN=<train>[,<train>] limits a run to those trains, for the same reason.
const onlyTrains = process.env['TRAIN'] === undefined ? undefined : new Set(process.env['TRAIN'].split(','));

for (const t of TRAINS.filter((train) => onlyTrains === undefined || onlyTrains.has(train.train))) {
  console.log(`\n=== ${t.train}`);
  const v2 = t.variant === 'v2';
  // The version a V2 wallet records once it has synced on a chain running ledger-v9, read from the train's own
  // abstractions rather than restated here.
  const protocolVersion = v2 ? (await loadDist(t.abs, 'index.js')).ProtocolVersion.V9NativeForkVersion : undefined;
  const variant = { variant: t.variant ?? 'v1', protocolVersion };
  if (wants('shielded')) await generateShieldedSet(t.train, t.sh, { family: t.shieldedFamily, ...variant });
  if (wants('unshielded')) {
    await (v2 ? generateUnshieldedSetV2(t.train, t.un, variant) : generateUnshieldedSet(t.train, t.un));
  }
  if (wants('dust')) await generateDust(t.train, t.du, t.sh, { flatDist: t.dustFlat === true, ...variant });
  if (wants('tx-history') && t.abs) {
    await (v2 ? generateTxHistoryV2 : generateTxHistory)(t.train, t.abs, t.fa);
  }
  if (wants('pending-transactions') && t.cap) await generatePendingTransactions(t.train, t.cap, t.sh);
}

if (wants('shielded') && onlyTrains === undefined) {
  console.log('\n=== MPT canonicity sweep (v7.0.2 → v8.0.3)');
  await mptSweep();
}

console.log('\nDone.');
