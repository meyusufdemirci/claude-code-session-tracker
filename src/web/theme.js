/**
 * The colour theme: resolved before the first paint, and owned in one place.
 *
 * Loaded as a plain script in the head of every page rather than a module, because
 * a module is deferred and deferring this shows a light page for a frame to
 * everyone who chose dark. It stamps the root element straight away, then wires the
 * control once the DOM it lives in exists.
 *
 * Three states rather than a two-way switch: `prefers-color-scheme` can say what the
 * OS wants but cannot be overridden, so following the OS has to be a stored choice
 * like the other two — stored as the absence of one.
 */
(() => {
  const KEY = 'cst-theme';
  const CHOICES = new Set(['system', 'light', 'dark']);
  const darkMedia = matchMedia('(prefers-color-scheme: dark)');

  /**
   * Storage is wrapped because a browser is allowed to refuse it — a private window,
   * a blocked-cookies setting. Losing the preference is survivable; a page that fails
   * to boot over it is not.
   */
  function read() {
    try {
      const stored = localStorage.getItem(KEY);
      return CHOICES.has(stored) ? stored : 'system';
    } catch {
      return 'system';
    }
  }

  function store(choice) {
    try {
      if (choice === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      // Then it lasts for this page view only.
    }
  }

  function apply(choice) {
    const dark = choice === 'dark' || (choice === 'system' && darkMedia.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    // Empty on the first call, which runs in the head — the buttons come later.
    for (const button of document.querySelectorAll('[data-theme-choice]')) {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === choice));
    }
  }

  apply(read());

  addEventListener('DOMContentLoaded', () => {
    apply(read());
    for (const button of document.querySelectorAll('[data-theme-choice]')) {
      button.addEventListener('click', () => {
        const choice = button.dataset.themeChoice;
        store(choice);
        apply(choice);
      });
    }
  });

  // Only meaningful while following the OS, but the listener costs nothing either way.
  darkMedia.addEventListener('change', () => {
    if (read() === 'system') apply('system');
  });
})();
