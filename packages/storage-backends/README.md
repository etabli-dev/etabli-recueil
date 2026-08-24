# `@recueil/storage-backends`

The WebDAV and S3 implementations of `StorageBackend`, and the conformance suite all three
implementations have to pass.

`@recueil/core` owns the contract (`packages/core/src/storage/backend.ts`) and the local filesystem
implementation. This package adds the two remote backends CONCEPT §5.1 promises. Nothing in
`@recueil/core` imports it, so a deployment that only writes to a local disk does not pull in the
AWS SDK.

```ts
import { createRecueil } from '@recueil/core';
import { S3Backend, WebDavBackend } from '@recueil/storage-backends';

const storage = new S3Backend({
  bucket: 'library',
  endpoint: 'http://minio.internal:9000',   // MinIO, Garage, Ceph RGW…
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});

const recueil = createRecueil({ databaseUrl, storagePath: '/unused', storage });
```

All three backends use the same layout — `<aa>/<bb>/<sha256>`, from ADR-0004 — and produce the same
`PutResult.key` for the same bytes, so a blob keeps its key when it is copied from one to another.
`path()` differs, because an absolute path, an object key and an https URL are different things.

---

## The shape of a remote `put`

Both remote backends do the same five things, in this order:

1. **Spool the source to a local scratch file, hashing it on the way.** The key cannot be known
   before the last byte has been read, and an HTTP request cannot be re-aimed after it has been
   sent. This costs scratch space the size of the blob (see the failure modes below) and buys three
   things: the existing object can be checked before anything is uploaded, a retry can resend the
   same bytes, and a multipart upload can be cut into parts of a known size.
2. **Ask what is already there.** `HEAD` / `HeadObject`.
3. **If something is there, check it** — its length always, its digest when `verify: 'digest'` is
   asked for. A hit is only declared on a check that passed. A mismatch is repaired from the bytes
   in hand, which were hashed on the way in and are therefore known-good, and reported as
   `repaired: true`.
4. **Upload**, atomically where the protocol allows it.
5. **Confirm the write** before returning, because neither protocol gives an end-to-end guarantee
   this backend can rely on. `verifyOnWrite: 'size'` (the default) is one metadata call;
   `'digest'` reads the object back; `'none'` believes the 200.

Reads verify as they stream, on both remote backends: the digest is computed over the bytes as they
flow to the caller and the stream fails at the end if it does not match the key. The local backend
does not do this — it hands back a plain read stream and offers `verify()` separately — which is a
difference the conformance suite records rather than papers over.

---

## Failure modes the local filesystem backend does not have

This section is the point of the package's documentation. Every item below is a way one of these
backends can fail that has no counterpart on a local disk, and most of them are silent unless you
go looking.

### Both remote backends

**Scratch space.** A `put` needs free space equal to the blob, locally, before anything is
uploaded — on top of the space the blob will occupy remotely. On the local backend the scratch file
and the final file are on one filesystem and `rename(2)` is free, so this never appears. Point
`scratchDirectory` at a volume with room for the largest thing you will ingest; `ENOSPC` there
surfaces as a `put` that fails before any request is made, which is the good version of the
problem.

**Latency is per-operation, not per-byte.** A `put` of a small blob is at least three round trips
(`HEAD`, `PUT`, `HEAD`), and `verify: 'digest'` adds a full download. An import of fifty thousand
Zotero attachments over a WAN is bounded by round trips, not bandwidth. Run the importer near the
store.

**A failure can be ambiguous in a way a local write never is.** A dropped connection during an
upload leaves the caller unable to tell whether the server committed the write. Both backends
resolve this the same way — the next `put` of those bytes finds whatever is there, checks it, and
repairs it if it is wrong — but a `put` that raised is not proof that nothing was written.

### WebDAV

**The server almost certainly ignores `Content-MD5`.** RFC 1864 is not part of RFC 4918, and the
overwhelming majority of WebDAV servers accept the header and never look at it. Recueil sends it
anyway (`sendContentMd5`, default on) because a server that does check it catches a corrupt upload
at the point of upload — but **you must not read "the `PUT` returned 201" as "the bytes arrived
intact"**. What actually catches a truncated upload here is the `HEAD` that follows the write and
compares lengths. A proxy that strips the header, or a server that silently discards it, changes
nothing about the guarantee, because there was no guarantee.

`OC-Checksum: SHA256:<hex>` (`sendOcChecksum`, default on) is the ownCloud/Nextcloud extension and
*is* verified by those servers. Everywhere else it is another header nobody reads.

**`PUT` is not atomic.** A connection cut mid-body leaves most servers holding a truncated file at
the destination — in a content-addressed store, a corrupt blob under a name that asserts a digest
it does not have. This backend therefore writes to `<root>/.tmp/<ulid>.part`, verifies the length
there, and then `MOVE`s the file into place; a `MOVE` within one collection is a rename on the
server's own filesystem on every server worth using. `writeStrategy: 'direct-put'` exists for
servers that cannot `MOVE` and **withdraws that guarantee**: an interrupted upload then leaves
exactly the corrupt blob described above. It will be repaired by the next `put` of the same bytes,
and until then reads of it fail verification rather than returning rubbish — but nothing repairs it
on its own.

**`MOVE`'s atomicity is the server's business.** Recueil can only ask. On a server that implements
`MOVE` as copy-then-delete, a crash mid-move can leave the destination partial. Nothing in the
protocol lets a client detect this in advance.

**Interrupted uploads leak into `.tmp`.** A process killed between the `PUT` and the `MOVE` leaves
a `.part` file that nothing collects. `listStrayTempFiles()` reports them. There is no sweep, and
no equivalent of the local backend's age-based `sweepTempFiles()`, because a `PROPFIND` gives no
reliable "last written" for an upload that is still in flight.

**Empty shard collections are never removed.** `DELETE` on a WebDAV collection is recursive, and
there is no race-free way to establish that a shard is empty first — a `DELETE` racing a concurrent
`put` into the same shard would destroy a blob. So `delete()` removes the object and leaves the two
collections. The worst case is 65 536 empty directories, one inode each.

**Some servers answer `HEAD` without `Content-Length`.** The size check is then impossible, and
this backend says so with a `StorageUnsupportedError` rather than guessing. Set `verifyOnPut` and
`verifyOnWrite` to `'digest'` for such a server and pay for a full read instead.

**A server may not be a WebDAV server at all.** The URL is checked once, lazily, with `OPTIONS`;
an endpoint that does not advertise `DAV: 1` is refused with an error naming the URL, rather than
producing a stream of confusing 405s later.

### S3

**A multipart upload is three operations, and the middle one can strand parts.** Above
`multipartThreshold` (16 MiB by default) an upload is `CreateMultipartUpload`, N × `UploadPart`,
`CompleteMultipartUpload`. Parts uploaded but never completed are **invisible to `ListObjects` and
billed until something removes them**. This backend aborts on every failure path, and raises
`StorageAbandonedUploadError` — carrying the key and the upload id — when even the abort fails.
That error is the only notice you will get. **Set a lifecycle rule for incomplete multipart uploads
on the bucket as well**; a process that is `SIGKILL`ed between two parts never runs an abort at all.

**A multipart object's checksum is not its digest.** A completed multipart object advertises a
*composite* `x-amz-checksum-sha256`: the hash of the concatenated part hashes, with `-N` appended.
It is not the SHA-256 of the object and must never be compared with one — a backend that did would
"repair" every large blob on every `put`, re-uploading the whole library forever. The same is true
of the `ETag`.

**A stored checksum is not evidence that the bytes are still right.** `x-amz-checksum-sha256`
records what was computed at upload time; S3 does not recompute it for an ordinary `GET`. An object
whose bytes have rotted still advertises the checksum it was written with. This backend uses that
header only to say *no* cheaply — a non-composite checksum that disagrees is a definite mismatch —
and never to say yes. `verify: 'digest'` always reads the object back and hashes it. Trusting the
metadata would be the filename-as-evidence mistake in a different costume.

**Read-after-write consistency is not universal.** S3 itself has been strongly read-after-write
consistent since December 2020. MinIO in distributed mode, Garage during a rebalance, and any
caching gateway in front of either are not. The symptom is a `put` whose `HeadObject` returns 404
immediately after a successful upload; this backend reports it as a `StorageRequestError` naming
the possibility, because it cannot distinguish replication lag from a lost write and will not
guess. With `verifyOnWrite: 'none'` the same condition instead surfaces as a `get` that raises
"not in the store" for a blob the database says exists.

**Deletes are eventually consistent, and `delete()` races.** `DeleteObject` returns 204 whether or
not the key existed, so the `false` the contract promises comes from a `HeadObject` taken first.
Two concurrent deletes of the same blob can therefore both return `true`.

**`aws-chunked` bodies.** Several S3-compatible gateways do not implement the trailer-based chunked
encoding the SDK will use for a streaming body with a checksum. This backend sends `Buffer` bodies
with an ordinary `Content-Length` for both single `PutObject`s and individual parts, and the fake
answers 501 if it ever sees an `aws-chunked` request, so a drift in SDK defaults fails a test rather
than a deployment.

**Part limits.** S3 allows at most 10 000 parts. `partSizeFor` doubles the part size until the blob
fits, so a 5 TiB object uses 1 GiB parts. A configured `partSize` below the 5 MiB minimum is raised
to it.

---

## Testing, and what the tests do and do not prove

Everything here is tested against **in-process fakes**: `startFakeWebDavServer` and
`startFakeS3Server`, both exported from `@recueil/storage-backends/testing`. No container is
required, no network is touched, and no test may ever be pointed at a real host.

**A fake is not a compatibility claim.** These fakes were written alongside the clients they test,
so they agree with them by construction. Passing against them establishes that the backends are
internally consistent and that they handle the failure shapes the fakes can produce; it establishes
**nothing** about Nextcloud, ownCloud, Apache `mod_dav`, MinIO, Garage, Ceph or Amazon S3. Recueil
has no captured trace from any of those, and until it does, no such claim should appear in this
repository. What the fakes are genuinely better at than a real service is failing on purpose: a 503
on the third request only, a part upload that fails, an abort that fails after it, a truncated
`PUT`, a read that misses immediately after a write.

The fakes' own behaviour is tested too — the S3 fake really does reject a bad `x-amz-checksum-sha256`
with `BadDigest` and a short part with `EntityTooSmall`; the WebDAV fake really does verify
`OC-Checksum` when asked and really does refuse a path that escapes its root — because a conformance
run against a fake that accepts everything proves nothing.

### The conformance suite

`runStorageBackendConformance` is exported from `@recueil/storage-backends/conformance` — not from
the package root, because it imports `vitest` and the root is imported by the server. It takes a
harness that produces a fresh, empty backend and, ideally, a `corrupt()` that can rewrite a stored
blob out of band. It is run in this package against all three backends, the local filesystem one
included, so "the backends are interchangeable" is a checked property rather than a type-level
assertion:

```ts
runStorageBackendConformance({
  name: 'MyBackend',
  create: async () => ({ backend, corrupt, dispose }),
  largeBlobSize: 12 * 1024 * 1024,
  capabilities: { verifiesOnRead: true },
});
```

Behaviour that is genuinely optional is declared in `capabilities` and tested only for the backends
that claim it, rather than being watered down until all three pass.

---

## Licence

AGPL-3.0-or-later.
