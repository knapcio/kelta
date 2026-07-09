const root = document.documentElement;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

setupReveals();
setupNavigation();
setupCopyButtons();
setupDemo();
setupInitialHash();

function setupReveals() {
  const elements = [...document.querySelectorAll("[data-reveal]")];
  if (reduceMotion || !("IntersectionObserver" in window)) {
    for (const element of elements) element.classList.add("is-visible");
    return;
  }

  root.classList.add("is-reveal-ready");
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8%", threshold: 0.08 },
  );

  for (const element of elements) observer.observe(element);
}

function setupNavigation() {
  const links = [...document.querySelectorAll('.primary-nav a[href^="#"]')];
  const linkById = new Map(
    links.map((link) => [link.getAttribute("href").slice(1), link]),
  );
  const targets = [...linkById.keys()]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  let scheduled = false;

  const update = () => {
    scheduled = false;
    const threshold = window.innerHeight * 0.34;
    let current;
    for (const target of targets) {
      if (target.getBoundingClientRect().top <= threshold) current = target;
    }

    for (const link of links) link.removeAttribute("aria-current");
    if (current) linkById.get(current.id)?.setAttribute("aria-current", "true");
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(update);
  };

  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  for (const link of links) {
    link.addEventListener("click", () => {
      for (const candidate of links) candidate.removeAttribute("aria-current");
      link.setAttribute("aria-current", "true");
    });
  }
  update();
}

function setupCopyButtons() {
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copy);
      if (!target) return;

      const original = button.textContent;
      try {
        await navigator.clipboard.writeText(target.textContent.trim());
        button.textContent = "Copied";
        button.dataset.copied = "true";
      } catch {
        button.textContent = "Copy unavailable";
      }

      window.setTimeout(() => {
        button.textContent = original;
        delete button.dataset.copied;
      }, 1600);
    });
  }
}

function setupDemo() {
  const frame = document.getElementById("kelta-demo");
  const openLink = document.getElementById("demo-open");
  const state = document.getElementById("demo-state");
  if (!frame || !openLink || !state) return;

  const repositoryPreview =
    location.protocol === "file:" || /(?:^|\/)site(?:\/|$)/.test(location.pathname);
  const demoUrl = new URL(repositoryPreview ? "../dist/" : "./demo/", location.href);

  openLink.href = demoUrl.href;
  frame.addEventListener("load", () => {
    let ready = false;
    try {
      const demoDocument = frame.contentDocument;
      ready = Boolean(
        demoDocument?.querySelector("#delta-resume") &&
          demoDocument.querySelector("[data-delta-row]"),
      );
    } catch {
      ready = false;
    }

    state.classList.toggle("ready", ready);
    state.classList.toggle("error", !ready);
    state.lastChild.textContent = ready ? " runtime resumed" : " demo build unavailable";
  });
  frame.src = demoUrl.href;
}

function setupInitialHash() {
  if (!location.hash) return;

  window.addEventListener(
    "load",
    () => {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (!target) return;

      window.requestAnimationFrame(() => {
        const previousBehavior = root.style.scrollBehavior;
        root.style.scrollBehavior = "auto";
        target.scrollIntoView({ block: "start" });
        root.style.scrollBehavior = previousBehavior;
      });
    },
    { once: true },
  );
}
