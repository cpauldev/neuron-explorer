import { useEffect, useState } from "react";
import {
  sceneColors,
  setSceneColor,
  resetSceneColors,
  SCENE_ROLES,
  SCENE_COLOR_EVENT,
  SCENE_COLOR_KEY,
} from "../../../explorer/static/scene-colors.js";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

import { ChoiceSelect } from "./choice-select";

type Scheme = "light" | "dark";

function ColorControl({
  role,
  colors,
  onChange,
}: {
  role: { key: string; label: string };
  colors: Record<string, string>;
  onChange: (key: string, color: string) => string | null;
}) {
  const value = colors[role.key];
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);
  const choose = (color: string) => {
    const message = onChange(role.key, color);
    setError(message);
    if (!message) setDraft(color);
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`scene-hex-${role.key}`} className="text-sm">
          {role.label}
        </label>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            type="color"
            aria-label={`${role.label} color`}
            value={value}
            onChange={(event) => choose(event.target.value)}
            className="scene-color-swatch size-8 shrink-0 cursor-pointer overflow-hidden rounded-md border-0 p-0"
          />
          <Input
            id={`scene-hex-${role.key}`}
            aria-label={`${role.label} hex color`}
            value={draft}
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            className="h-8 w-24 font-mono text-xs"
            aria-invalid={!!error}
            aria-describedby={
              error ? `scene-color-error-${role.key}` : undefined
            }
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (draft !== value) choose(draft);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                choose(draft);
              }
              if (event.key === "Escape") {
                setDraft(value);
                setError(null);
              }
            }}
          />
        </div>
      </div>
      {error && (
        <p
          id={`scene-color-error-${role.key}`}
          role="alert"
          className="text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}
export function SceneColorSettings() {
  const [scheme, setScheme] = useState<Scheme>(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  const [colors, setColors] = useState<Record<string, string>>(() =>
    sceneColors(scheme),
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => setColors(sceneColors(scheme));
    const storage = (event: StorageEvent) => {
      if (event.key === SCENE_COLOR_KEY || event.key === null) sync();
    };
    sync();
    window.addEventListener(SCENE_COLOR_EVENT, sync);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(SCENE_COLOR_EVENT, sync);
      window.removeEventListener("storage", storage);
    };
  }, [scheme]);
  return (
    <section
      className="border-t border-border pt-6"
      aria-labelledby="scene-colors-heading"
    >
      <h3 id="scene-colors-heading" className="text-sm font-semibold">
        Scene colors
      </h3>
      <div className="space-y-5 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ChoiceSelect
            aria-label="Scene color theme"
            value={scheme}
            onValueChange={(value) => {
              setScheme(value);
              setError(null);
            }}
            options={[
              { value: "light", label: "Light mode" },
              { value: "dark", label: "Dark mode" },
            ]}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setError(resetSceneColors(scheme))}
          >
            Reset colors
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {["Scene", "Connections"].map((group) => (
          <div key={group} className="space-y-3">
            <h4 className="text-xs font-medium text-muted-foreground">
              {group}
            </h4>
            {SCENE_ROLES.filter((role) => role.group === group).map((role) => (
              <ColorControl
                key={`${scheme}-${role.key}`}
                role={role}
                colors={colors}
                onChange={(key, color) => setSceneColor(scheme, key, color)}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
