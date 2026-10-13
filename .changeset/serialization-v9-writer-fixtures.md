---
---

test(serialization-tests): freeze what the ledger-v9 writer stores (#559)

Until now every frozen fixture came from facade 4.1.0 or older, so no gate checked what the V2 variant writes from
`forks.v9`. The unshielded `v2` and tx-history `v2` formats were backed only by a baseline that can be re-recorded.
This change teaches the fixture generator to drive a 5.0 train's V2 variant on ledger-v9, and adds payloads captured
from facade `5.0.0-rc.1`: the shielded and dust V2 snapshots, unshielded `v2`, and a tx-history `v2` holding
finalized, pending and rejected entries.

The tests that assumed every fixture predates 5.0 now handle both formats. The V1 reader is kept away from exactly
the payloads written from the fork. A `v2` history must give back each entry's lifecycle exactly as stored. A stored
`v2` unshielded snapshot must come back unchanged, while the key-tagging upgrade still applies to stored `v1`.

The rc.1 payloads stand in until 5.0.0 ships stable, and must be replaced before this merges. No SDK package changes.
