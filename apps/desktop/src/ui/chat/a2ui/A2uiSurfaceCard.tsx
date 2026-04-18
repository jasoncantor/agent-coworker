import { memo, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { ChevronDownIcon, ExpandIcon, SparklesIcon, Trash2Icon } from "lucide-react";

import { Card, CardContent } from "../../../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { cn } from "../../../lib/utils";
import { isBasicCatalogId } from "../../../../../../src/shared/a2ui/component";
import { stringifyDynamic } from "../../../../../../src/shared/a2ui/expressions";
import { resolveDynamicWithFunctions } from "../../../../../../src/shared/a2ui/functions";
import { useAppStore } from "../../../app/store";
import type { FeedItem } from "../../../app/types";
import { A2uiRenderer, type A2uiActionDispatcher, type A2uiRenderableComponent } from "./A2uiRenderer";

type UiSurfaceFeedItem = Extract<FeedItem, { kind: "ui_surface" }>;

type A2uiSurfaceCardProps = {
  item: UiSurfaceFeedItem;
};

/**
 * Convert `theme` to CSS custom properties scoped to the card. We accept a
 * permissive list of keys and silently ignore the rest to avoid leaking theme
 * data into the host styling.
 */
function buildThemeStyle(theme?: Record<string, unknown>): CSSProperties | undefined {
  if (!theme) return undefined;
  const style: Record<string, string> = {};
  const primaryColor = theme.primaryColor;
  if (typeof primaryColor === "string") {
    style["--a2ui-primary"] = primaryColor;
  }
  const fontFamily = theme.fontFamily;
  if (typeof fontFamily === "string") {
    style["--a2ui-font-family"] = fontFamily;
    style.fontFamily = fontFamily;
  }
  const background = theme.background;
  if (typeof background === "string") {
    style["--a2ui-background"] = background;
    style.background = background;
  }
  return style as CSSProperties;
}

function extractSurfaceTitle(root: A2uiRenderableComponent | null, dataModel: unknown): string | null {
  if (!root) return null;
  const queue: A2uiRenderableComponent[] = [root];
  let fallbackText: string | null = null;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (
      (current.type === "Heading" || current.type === "Text" || current.type === "Paragraph")
      && current.props
      && typeof current.props === "object"
    ) {
      const props = current.props as Record<string, unknown>;
      const text = stringifyDynamic(
        resolveDynamicWithFunctions(props.text ?? props.label ?? props.value, dataModel),
      ).trim();
      if (text) {
        if (current.type === "Heading") return text;
        if (!fallbackText) fallbackText = text;
      }
    }
    if (Array.isArray(current.children)) {
      for (const child of current.children) {
        if (child && typeof child === "object" && !Array.isArray(child)) {
          queue.push(child as A2uiRenderableComponent);
        }
      }
    }
  }
  return fallbackText;
}

export const A2uiSurfaceCard = memo(function A2uiSurfaceCard({ item }: A2uiSurfaceCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [poppedOut, setPoppedOut] = useState(false);
  const themeStyle = useMemo(() => buildThemeStyle(item.theme), [item.theme]);

  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const dispatchA2uiAction = useAppStore((s) => s.dispatchA2uiAction);

  const onAction = useMemo<A2uiActionDispatcher | undefined>(() => {
    if (!selectedThreadId || item.deleted) return undefined;
    return async ({ componentId, eventType, payload }) => {
      await dispatchA2uiAction({
        threadId: selectedThreadId,
        surfaceId: item.surfaceId,
        componentId,
        eventType,
        ...(payload !== undefined ? { payload } : {}),
      });
    };
  }, [dispatchA2uiAction, item.deleted, item.surfaceId, selectedThreadId]);


  const rootComponent = useMemo<A2uiRenderableComponent | null>(() => {
    const root = item.root;
    if (!root || typeof root !== "object" || Array.isArray(root)) return null;
    return root as A2uiRenderableComponent;
  }, [item.root]);
  const surfaceTitle = useMemo(
    () => extractSurfaceTitle(rootComponent, item.dataModel) ?? item.surfaceId,
    [item.dataModel, item.surfaceId, rootComponent],
  );

  const unsupportedCatalog = !isBasicCatalogId(item.catalogId);

  if (item.deleted) {
    return (
      <Card className="w-full max-w-4xl border-dashed border-border/60 bg-muted/20">
        <CardContent className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Trash2Icon className="size-3.5" />
          <span>Generative UI surface <code className="font-mono">{item.surfaceId}</code> was deleted.</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="w-full max-w-4xl overflow-hidden border-border/50 bg-background/80 shadow-sm">
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <div className="flex items-center gap-1 border-b border-border/40 pr-2">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex flex-1 items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20",
                  !expanded && "border-b-transparent",
                )}
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    <SparklesIcon className="size-3.5 text-primary" />
                    Generative UI
                    <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground/70">
                      {item.surfaceId}
                    </code>
                    {unsupportedCatalog ? (
                      <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-warning">
                        unknown catalog
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate text-sm font-semibold text-foreground">
                    {surfaceTitle}
                  </span>
                </span>
                <ChevronDownIcon
                  className={cn(
                    "size-3.5 text-muted-foreground transition-transform",
                    expanded ? "rotate-0" : "-rotate-90",
                  )}
                />
              </button>
            </CollapsibleTrigger>
            <button
              type="button"
              title="Open in larger view"
              aria-label="Open in larger view"
              onClick={() => setPoppedOut(true)}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
            >
              <ExpandIcon className="size-3.5" />
            </button>
          </div>
          <CollapsibleContent>
            <CardContent className="p-4" style={themeStyle}>
              {unsupportedCatalog ? (
                <div className="mb-3 rounded border border-warning/35 bg-warning/[0.08] p-2 text-xs text-warning">
                  This surface uses an unsupported catalog. Rendering with best-effort basic primitives — some components may be skipped.
                  <div className="mt-1 font-mono text-[10px] text-warning/80">
                    {item.catalogId}
                  </div>
                </div>
              ) : null}
              <div className="rounded-xl border border-border/40 bg-background/35 p-4">
                <A2uiRenderer
                  root={rootComponent}
                  dataModel={item.dataModel}
                  {...(onAction ? { onAction } : {})}
                />
              </div>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
      <Dialog open={poppedOut} onOpenChange={setPoppedOut}>
        <DialogContent showClose className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              <span className="flex items-center gap-2 text-sm font-semibold">
                <SparklesIcon className="size-4 text-primary" />
                {surfaceTitle}
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto rounded-xl border border-border/40 bg-background/35 p-4" style={themeStyle}>
            {unsupportedCatalog ? (
              <div className="mb-3 rounded border border-warning/35 bg-warning/[0.08] p-2 text-xs text-warning">
                Unsupported catalog: <span className="font-mono text-[10px] text-warning/80">{item.catalogId}</span>
              </div>
            ) : null}
            <A2uiRenderer
              root={rootComponent}
              dataModel={item.dataModel}
              {...(onAction ? { onAction } : {})}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
});

export const __internal = {
  extractSurfaceTitle,
};
