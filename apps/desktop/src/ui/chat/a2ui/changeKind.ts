import type { A2uiChangeKind } from "../../../app/types";

/**
 * Short human-readable label for an A2UI envelope kind. Used in the revision
 * picker and inline history row.
 */
export function changeKindLabel(kind: A2uiChangeKind | undefined): string {
  switch (kind) {
    case "createSurface":
      return "Created";
    case "updateComponents":
      return "Layout update";
    case "updateDataModel":
      return "Data update";
    case "deleteSurface":
      return "Deleted";
    default:
      return "Updated";
  }
}

/**
 * Tailwind tone classes (bg + border + text) for a small chip showing the
 * changeKind. Uses semantic design tokens only — never raw color literals.
 */
export function changeKindToneClass(kind: A2uiChangeKind | undefined): string {
  switch (kind) {
    case "createSurface":
      return "border-primary/30 bg-primary/10 text-primary";
    case "updateComponents":
      return "border-warning/30 bg-warning/10 text-warning";
    case "updateDataModel":
      return "border-success/30 bg-success/10 text-success";
    case "deleteSurface":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    default:
      return "border-border/50 bg-muted/40 text-muted-foreground";
  }
}
