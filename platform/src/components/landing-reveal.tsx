"use client";

import { useEffect, useRef, useState, type ElementType, type ReactNode } from "react";

import { cx } from "@/components/ui";

/**
 * Scroll-reveal wrapper. Progressive enhancement: the server renders children
 * fully visible, so no-JS visitors and crawlers see everything. After mount it
 * arms the hidden state and reveals the element when it scrolls into view. The
 * CSS honours prefers-reduced-motion, where it simply stays visible.
 */
export function Reveal({
  children,
  className,
  as: Tag = "div" as ElementType,
  delayMs = 0,
}: {
  children: ReactNode;
  className?: string;
  as?: ElementType;
  delayMs?: number;
}) {
  const ref = useRef<HTMLElement>(null);
  const [armed, setArmed] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }
    setArmed(true);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      className={cx(className, armed && "lp-reveal")}
      data-shown={shown ? "true" : undefined}
      style={delayMs ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
