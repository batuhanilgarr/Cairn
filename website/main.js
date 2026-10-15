// Menu, demo replay and copy buttons. Everything else on this site is plain HTML and CSS. No network requests.
(() => {
  const nav = document.querySelector(".nav");
  const btn = document.getElementById("menu-btn");
  if (nav && btn) {
    const set = (open) => {
      nav.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
    };
    btn.addEventListener("click", () => set(!nav.classList.contains("open")));
    nav.addEventListener("click", (e) => e.target.closest("a") && set(false));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && nav.classList.contains("open")) {
        set(false);
        btn.focus();
      }
    });
  }

  // Demo: the finished state is in the HTML already; Send replays the response arriving line by line.
  const demo = document.getElementById("demo");
  const send = document.getElementById("send");
  if (demo && send) {
    const run = () => {
      demo.classList.remove("sent");
      void demo.offsetWidth; // restart the animation
      demo.querySelectorAll(".r").forEach((el, i) => el.style.setProperty("--i", String(i)));
      demo.classList.add("sent");
    };
    send.addEventListener("click", run);
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
    });
  }

  document.querySelectorAll("[data-copy]").forEach((b) => {
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.getAttribute("data-copy"));
        const old = b.textContent;
        b.textContent = "Copied";
        setTimeout(() => (b.textContent = old), 1400);
      } catch {
        /* clipboard unavailable: the text stays selectable */
      }
    });
  });
})();
