"use client";
import { useEffect, useRef } from "react";

/**
 * Marks a sideways scroller with data-fade-start and data-fade-end while content runs past that edge, so the edge
 * fades (controls.css) and a person can see there is more to scroll to. Follows scrolling, resizing and content
 * changes.
 */
export function useEdgeFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const max = el.scrollWidth - el.clientWidth;
      const start = max > 1 && el.scrollLeft > 1;
      const end = max > 1 && el.scrollLeft < max - 1;
      if (el.dataset.fadeStart !== String(start)) el.dataset.fadeStart = String(start);
      if (el.dataset.fadeEnd !== String(end)) el.dataset.fadeEnd = String(end);
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    const mo = new MutationObserver(read);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { el.removeEventListener("scroll", read); ro.disconnect(); mo.disconnect(); };
  }, []);
  return ref;
}
