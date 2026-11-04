import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Print",
};

/**
 * The print surface.
 *
 * Deliberately outside the console Shell: a document that prints with the
 * sidebar, the header and the theme toggle on it is not a document. The root
 * layout (src/app/layout.tsx) still owns `<html>`/`<body>` and loads
 * globals.css for the whole app, so this layout cannot re-declare them; what
 * it does is force the light scheme. The root's ThemeScript may have put
 * `dark` on `<html>` from the user's preference, and paper is white: the
 * inline script below runs after it and removes the class before first paint,
 * and `.print-doc` re-declares the light tokens so a dark theme cannot leak
 * into the document even if the class comes back.
 */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="print-root min-h-screen bg-white text-[#0f1729]" data-theme="light">
      <script
        dangerouslySetInnerHTML={{
          __html:
            "document.documentElement.classList.remove('dark');document.documentElement.style.colorScheme='light';",
        }}
      />
      {children}
    </div>
  );
}
