/** The OpenAPI surface of the contract, importable as `@recueil/schemas/openapi`. */
export {
  API_VERSION,
  OPENAPI_VERSION,
  createOpenApiDocument,
  renderOpenApiYaml,
} from './document.js';
export type { OpenApiDocument, OpenApiDocumentOptions } from './document.js';
export {
  componentSchemaNames,
  componentSchemas,
  AnnotationPageSchema,
  AttachmentPageSchema,
  CollectionPageSchema,
  CreatorPageSchema,
  CustomFieldPageSchema,
  DocumentPageSchema,
  FieldValuePageSchema,
  ItemPageSchema,
  NotePageSchema,
  TagPageSchema,
} from './components.js';
export { API_BASE_PATH, JSON_CONTENT_TYPE, healthPaths, paths, phase1Paths } from './paths.js';
