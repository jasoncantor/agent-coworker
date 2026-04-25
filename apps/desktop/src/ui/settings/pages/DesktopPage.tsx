import { useAppStore } from "../../../app/store";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";
import { showQuickChatWindow } from "../../../lib/desktopCommands";

export function DesktopPage() {
  const quickChatIconEnabled = useAppStore((s) => s.desktopSettings.quickChat.iconEnabled);
  const menuBarAvailable = useAppStore((s) => s.desktopFeatureFlags.menuBar);
  const setQuickChatIconEnabled = useAppStore((s) => s.setQuickChatIconEnabled);

  return (
    <Card className="border-border/80 bg-card/85">
      <CardHeader>
        <CardTitle>Quick chat</CardTitle>
        <CardDescription>
          Open the lighter-weight floating chat surface without bringing the full app window forward.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4 rounded-xl border border-border/70 bg-muted/15 p-4 max-[960px]:flex-col">
          <div>
            <div className="text-sm font-medium text-foreground">Show quick chat icon</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Keep the compact popup available from the macOS menu bar or Windows system tray.
            </div>
            {!menuBarAvailable ? (
              <div className="mt-1 text-xs text-warning">
                Enable the Menu bar / tray feature flag to show the icon.
              </div>
            ) : null}
          </div>
          <Switch
            checked={quickChatIconEnabled}
            disabled={!menuBarAvailable}
            aria-label="Show quick chat icon"
            onCheckedChange={(checked) => setQuickChatIconEnabled(checked)}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void showQuickChatWindow()}>
            Open quick chat
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
