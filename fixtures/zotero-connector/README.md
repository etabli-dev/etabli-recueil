# Captured Zotero Connector fixtures

ADR-0006 buys web capture by answering a protocol nobody documents. A compatibility claim about an
undocumented protocol is worth exactly as much as the evidence behind it, and "our handler satisfies
our own Zod schema" is not evidence — it is the same author agreeing with himself twice.

So the files here are **verbatim excerpts of the upstream sources**, captured at pinned commits and
used as the oracle in `apps/server/test/connector.test.ts`. The test does not assert that Recueil's
response looks reasonable; it runs the real consumer code over Recueil's real response and fails
when that code throws or reaches the wrong conclusion.

## What was captured, and from where

| File | Upstream repository | Path | Commit | Lines |
| --- | --- | --- | --- | --- |
| `progressWindow_inject.updateFromClient.js` | `zotero/zotero-connectors` | `src/common/inject/progressWindow_inject.js` | `c279ccc61d80f99b8d9275e9315d05cb66617f2e` | 100–173 |
| `connector.callMethod.online-state.js` | `zotero/zotero-connectors` | `src/common/connector.js` | `c279ccc61d80f99b8d9275e9315d05cb66617f2e` | 220–245 |
| `server_connector.GetSelectedCollection.js` | `zotero/zotero` | `chrome/content/zotero/xpcom/server/server_connector.js` | `f2a42bec150fa8b947ffde57afd72a22e805f085` | 938–982 |
| `server_connector.endpoints.txt` | `zotero/zotero` | as above | as above | every `Zotero.Server.Endpoints["/connector/…"]` registration, sorted |

Both commits are the tip of their default branch on 2026-08-22 (`master` and `main` respectively).
The captured bytes were checked against `raw.githubusercontent.com` at those exact commit ids, not
against a branch name.

## What each one proves

- **`progressWindow_inject.updateFromClient.js`** is the code the extension runs on the answer to
  `/connector/getSelectedCollection`. Line 153 of the upstream file is
  `let targets = response.targets.filter(t => !isFilesEditable || t.filesEditable);` — an
  unconditional dereference. A response without `targets` throws a `TypeError` in the progress
  window on *every* capture. The comment that used to sit over Recueil's handler, claiming the field
  was optional, was wrong, and this file is why.
- **`connector.callMethod.online-state.js`** is the extension's transport. It reads
  `X-Zotero-Version` off *every* response and, on any status ≥ 400 that lacks the header, sets
  `Zotero.Connector.isOnline = false` — a **global** flag, not a per-call one. One unimplemented
  `/connector/*` sub-call answering a bare 404 therefore takes browser capture offline entirely.
- **`server_connector.GetSelectedCollection.js`** is the response Zotero itself builds, which is
  what fixes the shape of `targets` (`{ id, name, filesEditable, level }`, `id` being a
  `treeViewID` such as `L1`) and of `tags` (`{ [treeViewID]: [{ tag }] }`).
- **`server_connector.endpoints.txt`** is the complete list of endpoints the Zotero client serves.
  `/connector/sessionProgress` is not in it, and `grep -ri sessionprogress` over the whole connector
  source tree at `c279ccc` returns nothing. Recueil's endpoint of that name was not part of the
  protocol; it is now marked as a Recueil extension and authenticated.

## Licence

Zotero and the Zotero Connector are AGPL-3.0. Recueil is AGPL-3.0-or-later, so these excerpts are
included under the same licence, with attribution to the Center for History and New Media / Corporation
for Digital Scholarship. They are test fixtures: nothing here is shipped in a Recueil artefact.

## Re-capturing

```sh
COMMIT=c279ccc61d80f99b8d9275e9315d05cb66617f2e
BASE=https://raw.githubusercontent.com/zotero/zotero-connectors/$COMMIT
curl -sS $BASE/src/common/inject/progressWindow_inject.js | sed -n '100,173p' \
  > fixtures/zotero-connector/progressWindow_inject.updateFromClient.js
curl -sS $BASE/src/common/connector.js | sed -n '220,245p' \
  > fixtures/zotero-connector/connector.callMethod.online-state.js

ZCOMMIT=f2a42bec150fa8b947ffde57afd72a22e805f085
ZFILE=https://raw.githubusercontent.com/zotero/zotero/$ZCOMMIT/chrome/content/zotero/xpcom/server/server_connector.js
curl -sS $ZFILE | sed -n '938,982p' \
  > fixtures/zotero-connector/server_connector.GetSelectedCollection.js
curl -sS $ZFILE | grep -o 'Zotero\.Server\.Endpoints\["/connector/[^"]*"\]' \
  | sed 's|Zotero.Server.Endpoints\["||;s|"\]||' | sort -u \
  > fixtures/zotero-connector/server_connector.endpoints.txt
```

When upstream moves, the line ranges move with it. Re-capture, re-read the excerpt, and update this
table — a fixture whose provenance is stale is worse than no fixture.
