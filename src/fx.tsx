import { useEffect } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";

/** Lists ease in with AutoAnimate (formkit/auto-animate, MIT). */
export function useListMotion() {
  return useAutoAnimate<HTMLElement>({ duration: 180, easing: "ease-out" });
}

/**
 * Click ripple for every button.
 * The ring treatment follows Magic UI's ripple (magicuidesign/magicui, MIT),
 * recolored to PatentFlow blue.
 */
export function ClickRipple() {
  useEffect(() => {
    const root = document.querySelector(".dsh");
    if (!root) return;
    const onClick = (event: Event) => {
      const mouse = event as MouseEvent;
      const target = (mouse.target as HTMLElement | null)?.closest("button, .btn, .chip, .nav-btn");
      if (!target || (target as HTMLButtonElement).disabled) return;
      const dot = document.createElement("span");
      dot.className = "pf-ripple";
      const size = Math.max(target.getBoundingClientRect().width, 28);
      dot.style.width = `${size}px`;
      dot.style.height = `${size}px`;
      dot.style.left = `${mouse.clientX - size / 2}px`;
      dot.style.top = `${mouse.clientY - size / 2}px`;
      document.body.appendChild(dot);
      window.setTimeout(() => dot.remove(), 540);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, []);
  return null;
}
