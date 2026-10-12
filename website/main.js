// Copy buttons. Everything else on this site is plain HTML and CSS.
document.querySelectorAll("[data-copy]").forEach((b) => {
  b.addEventListener("click", async () => {
    try {
      const text = b.getAttribute("data-copy").replace(/&amp;/g, "&");
      await navigator.clipboard.writeText(text);
      const old = b.textContent;
      b.textContent = "Copied ✓";
      setTimeout(() => (b.textContent = old), 1400);
    } catch {
      /* clipboard unavailable: leave the text selectable */
    }
  });
});
