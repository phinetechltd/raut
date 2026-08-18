"use client";

import { useEffect, useState } from "react";

type Mode = "light" | "dark" | "system";

const KEY = "raut.theme";

/**
 * Theme switcher.
 *
 * Three states rather than two: "system" is the default so the console follows
 * the OS until someone deliberately overrides it. An explicit choice is what
 * gets stored — storing the *resolved* value would silently freeze a user out
 * of their OS setting the first time they toggled.
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem(KEY) as Mode | null;
    if (stored === "light" || stored === "dark" || stored === "system") {
      setMode(stored);
    }
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = mode === "dark" || (mode === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };

    apply();
    localStorage.setItem(KEY, mode);

    // Only track the OS while actually deferring to it.
    if (mode !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode, mounted]);

  const options: Array<{ value: Mode; label: string; icon: string }> = [
    { value: "light", label: "Light", icon: "☀" },
    { value: "dark", label: "Dark", icon: "☾" },
    { value: "system", label: "System", icon: "◐" },
  ];

  return (
    <div
      className="inline-flex rounded-lg border border-border bg-surface-sunken p-0.5"
      role="radiogroup"
      aria-label="Colour theme"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={mounted ? mode === o.value : undefined}
          aria-label={o.label}
          title={o.label}
          onClick={() => setMode(o.value)}
          className={`grid h-7 w-8 place-items-center rounded text-sm transition-colors ${
            mounted && mode === o.value
              ? "bg-surface text-accent shadow-sm"
              : "text-content-muted hover:text-content"
          }`}
        >
          <span aria-hidden="true">{o.icon}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Applies the stored theme before first paint.
 *
 * Without this the console renders light, then snaps to dark once React
 * hydrates — a flash that looks like a bug. Injected as a blocking inline
 * script in the document head, which is the only place early enough.
 */
export function ThemeScript() {
  const js = `(function(){try{
var m=localStorage.getItem('${KEY}')||'system';
var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.classList.toggle('dark',d);
}catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}
