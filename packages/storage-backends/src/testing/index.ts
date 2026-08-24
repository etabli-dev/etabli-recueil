/**
 * In-process fakes for the two remote backends.
 *
 * They are exported rather than buried in `test/` so that the server, the CLI and any plugin that
 * wants to exercise a remote backend can do it in a unit test, with no container and no network.
 *
 * Read the header of each module before trusting one for anything beyond a test: a fake proves that
 * the client is internally consistent, and nothing whatever about Nextcloud, MinIO or S3.
 */
export * from './webdav-server.js';
export * from './s3-server.js';
