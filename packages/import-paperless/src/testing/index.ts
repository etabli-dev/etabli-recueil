/**
 * `@recueil/import-paperless/testing` — the fake Paperless-ngx server and its fixture library.
 *
 * Published as a subpath rather than kept in `test/` so that the server-side and CLI tests of a
 * Paperless import can use the same fake, and so that a reader can find, in one place, exactly what
 * this package has and has not been proven against. See `README.md` §"What is unproven".
 */
export { FakePaperlessServer } from './fake-server.js';
export type {
  FakeFault,
  FakeLibrary,
  FakeOriginal,
  FakeRequest,
  FakeServerOptions,
} from './fake-server.js';
export {
  FIXTURE_EXPECTATIONS,
  FIXTURE_TOKEN,
  fakePdf,
  fakePng,
  fixtureCustomFields,
  fixtureLibrary,
} from './fixtures.js';
