// Demo: "Send" reveals the response, line by line. Everything else on this site is plain HTML and CSS.
(() => {
  const demo = document.getElementById("demo");
  const send = document.getElementById("send");
  if (!demo || !send) return;
  const show = (id, on) => (document.getElementById(id).hidden = !on);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const run = () => {
    demo.classList.remove("sent");
    void demo.offsetWidth; // restart the animation when sent again
    document.querySelectorAll("#out .r").forEach((el, i) => el.style.setProperty("--i", String(i)));
    show("idle", false);
    show("status", true);
    show("out", true);
    show("pass", true);
    demo.classList.add("sent");
  };

  send.addEventListener("click", run);
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
  });
  // Show a finished state on load for reduced motion, otherwise send once so the page is not empty on arrival.
  setTimeout(run, reduced ? 0 : 900);
})();

// Copy buttons.
document.querySelectorAll("[data-copy]").forEach((b) => {
  b.addEventListener("click", async () => {
    try {
      const text = b.getAttribute("data-copy").replace(/&amp;/g, "&");
      await navigator.clipboard.writeText(text);
      const old = b.textContent;
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = old), 1400);
    } catch {
      /* clipboard unavailable: leave the text selectable */
    }
  });
});
