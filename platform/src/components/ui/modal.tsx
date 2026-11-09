"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { CloseIcon } from "./icons";
import { Button, cx } from "./primitives";

/**
 * Accessible modal dialog used by every create/edit form in the console.
 * Renders nothing when closed, uses the native <dialog> semantics via role
 * markup, and closes on Escape and backdrop click. Forms live in each module's
 * page folder; this is only the chrome.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus the panel so keyboard/screen-reader users land inside the dialog.
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(
      "input, select, textarea, button",
    );
    firstFocusable?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center overflow-y-auto bg-black/45 p-4 backdrop-blur-[2px] sm:items-center"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ animation: "fade-in 120ms ease-out" }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          "w-full rounded-xl border border-border bg-surface shadow-xl",
          width,
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-sm text-content-muted">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          >
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="max-h-[min(72vh,720px)] overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

/** Trigger button that owns its open state; the modal renders its children. */
export function ModalButton({
  label,
  title,
  description,
  variant = "primary",
  size = "sm",
  width,
  children,
}: {
  label: ReactNode;
  title: string;
  description?: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  width?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Modal open={open} onClose={close} title={title} description={description} width={width}>
        {children(close)}
      </Modal>
    </>
  );
}
