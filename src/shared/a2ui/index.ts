export {
  A2UI_PROTOCOL_VERSION,
  A2UI_MAX_ENVELOPE_BYTES,
  a2uiComponentSchema,
  a2uiEnvelopeSchema,
  parseA2uiEnvelope,
  envelopeKind,
  envelopeSurfaceId,
} from "./protocol";
export type {
  A2uiComponent,
  A2uiCreateSurface,
  A2uiDeleteSurface,
  A2uiEnvelope,
  A2uiEnvelopeKind,
  A2uiUpdateComponents,
  A2uiUpdateDataModel,
  ParsedEnvelope,
} from "./protocol";

export {
  A2UI_BASIC_CATALOG_ID,
  SUPPORTED_BASIC_CATALOG_COMPONENT_TYPES,
  describeSupportedComponents,
  isBasicCatalogId,
  isSupportedBasicComponentType,
} from "./component";
export type { SupportedBasicComponentType } from "./component";

export {
  formatString,
  getByPointer,
  resolveDynamic,
  resolveDynamicBoolean,
  resolveDynamicNumber,
  resolveDynamicString,
  setByPointer,
  splitPointer,
  stringifyDynamic,
} from "./expressions";
export type { DataModel, DynamicLike } from "./expressions";

export { applyEnvelope, createEmptySurfaces, toSerializable } from "./surface";
export type { A2uiSurfacesById, A2uiSurfaceState, ApplyEnvelopeResult } from "./surface";
