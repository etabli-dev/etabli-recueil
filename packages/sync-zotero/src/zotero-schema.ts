/**
 * Zotero's global schema, as the mapping needs it.
 *
 * The Web API's item JSON names each field as recorded (`university`, `institution`) and says
 * nothing about base fields; `GET /schema` does. The local importer reads the same facts from
 * `zotero.sqlite` (`baseFieldMappingsCombined`, `itemTypeCreatorTypes.primaryField`), so reading
 * them from the schema here is what lets both paths share `mapZoteroFields`.
 */
import type { ZoteroGlobalSchemaJson } from './api/types.js';

export class ZoteroSchema {
  private readonly fieldsByType = new Map<string, Map<string, string>>();
  private readonly creatorTypesByType = new Map<string, string[]>();
  readonly primaryCreatorTypes = new Map<string, string>();

  constructor(readonly json: ZoteroGlobalSchemaJson) {
    for (const type of json.itemTypes) {
      const fields = new Map<string, string>();
      for (const field of type.fields) fields.set(field.field, field.baseField ?? field.field);
      this.fieldsByType.set(type.itemType, fields);
      this.creatorTypesByType.set(
        type.itemType,
        type.creatorTypes.map((creator) => creator.creatorType),
      );
      const primary = type.creatorTypes.find((creator) => creator.primary === true);
      if (primary !== undefined) this.primaryCreatorTypes.set(type.itemType, primary.creatorType);
    }
  }

  hasItemType(itemType: string): boolean {
    return this.fieldsByType.has(itemType);
  }

  /** Field → base field, for the fields this item type has. */
  fields(itemType: string): ReadonlyMap<string, string> {
    return this.fieldsByType.get(itemType) ?? new Map();
  }

  creatorTypes(itemType: string): readonly string[] {
    return this.creatorTypesByType.get(itemType) ?? [];
  }

  itemTypes(): string[] {
    return [...this.fieldsByType.keys()];
  }
}
