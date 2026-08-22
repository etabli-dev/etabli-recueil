/**
 * Registering the core item-pane sections.
 *
 * Importing this module is what puts them in the registry. They use the same `register` call a
 * plugin will (CONCEPT.md §5.13): there is no core-only path, which is the only way to know the
 * extension point works before anything extends it.
 *
 * Orders leave gaps of ten so that a contributed section can sit between two core ones without
 * anybody renumbering.
 */
import { itemPaneSections } from '../registry.js';
import { AttachmentsSection } from './attachments.js';
import { BibliographicSection } from './bibliographic.js';
import { CollectionsSection } from './collections.js';
import { CustomFieldsSection } from './custom-fields.js';
import { NotesSection } from './notes.js';
import { TagsSection } from './tags.js';

export { setAttachmentOpener } from './attachments.js';

let registered = false;

/** Idempotent, because the module graph may reach it from the app and from a test in one process. */
export const registerCoreSections = (): void => {
  if (registered) return;
  registered = true;

  itemPaneSections.register({
    id: 'core.bibliographic',
    title: 'Bibliographic',
    order: 10,
    source: 'core',
    Component: BibliographicSection,
    // Absent on the invoices, letters and photographs that make up half a real library (I1).
    isVisible: (item) => item.bibliographic !== null && item.bibliographic !== undefined,
  });

  itemPaneSections.register({
    id: 'core.attachments',
    title: 'Attachments',
    order: 20,
    source: 'core',
    Component: AttachmentsSection,
  });

  itemPaneSections.register({
    id: 'core.tags',
    title: 'Tags',
    order: 30,
    source: 'core',
    Component: TagsSection,
  });

  itemPaneSections.register({
    id: 'core.collections',
    title: 'Collections',
    order: 40,
    source: 'core',
    Component: CollectionsSection,
  });

  itemPaneSections.register({
    id: 'core.notes',
    title: 'Notes',
    order: 50,
    source: 'core',
    Component: NotesSection,
  });

  itemPaneSections.register({
    id: 'core.custom-fields',
    title: 'Custom fields',
    order: 60,
    source: 'core',
    Component: CustomFieldsSection,
  });
};
