// @ts-check
/**
 * Mobile navigation drawer controller.
 *
 * Owns every piece of responsive drawer state so the shell markup, app.js and
 * tests share a single source of truth: open/close classes, overlay visibility,
 * modal semantics, background inertness, scroll lock, focus movement and the
 * Tab focus trap.
 */

const MOBILE_BREAKPOINT_QUERY = '(max-width: 860px)';
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * @typedef {Object} ShellOptions
 * @property {Document} [document] Document that owns the shell markup.
 * @property {Window} [window] Window used for breakpoint and resize listeners.
 * @property {(anchor: HTMLAnchorElement, event: MouseEvent) => void} [onNavigate]
 *   Called after a navigation link inside the drawer is activated. The click is
 *   never cancelled, so app.js can keep handling its own navigation.
 */

/**
 * @typedef {Object} ShellController
 * @property {() => boolean} open Opens the drawer. Returns whether it is open.
 * @property {(options?: { restoreFocus?: boolean }) => boolean} close Closes the drawer.
 * @property {() => void} destroy Removes every listener and disables the controller.
 * @property {() => boolean} isOpen Reports the current drawer state.
 */

/**
 * @typedef {'list'|'map'} SpaceView
 */

/**
 * @typedef {Object} SpaNavigationOptions
 * @property {Document} [document] Document that owns the navigation links.
 * @property {Window} [window] Window whose history receives the pushed entry.
 * @property {(path: string) => void} [onNavigate] Called after the URL is pushed.
 */

/**
 * @typedef {Object} SpaNavigationController
 * @property {() => void} destroy Removes every listener.
 */

/**
 * Wire the shell links that navigate inside the SPA (brand, All spaces, logs).
 *
 * The helper only owns the click interception and the `pushState` call. It
 * deliberately delegates route rendering to `onNavigate`, so app.js keeps the
 * routing contract in one place.
 *
 * Modifier and non-primary clicks fall through to the browser so users can open
 * links in a new tab or window.
 *
 * @param {SpaNavigationOptions} [options]
 * @returns {SpaNavigationController}
 */
export function setupSpaNavigation(options = {}) {
  const doc = options.document ?? /** @type {Document} */ (globalThis.document);
  const win = options.window ?? /** @type {Window} */ (globalThis.window);
  const onNavigate = options.onNavigate;

  /** @type {HTMLAnchorElement[]} */
  const links = [];
  const logsLink = doc.getElementById('logs-link');
  const allSpacesLink = doc.getElementById('all-spaces-link');
  const brandLink = doc.getElementById('brand-link') ?? doc.querySelector('a.brand');
  for (const candidate of [brandLink, allSpacesLink, logsLink]) {
    if (candidate instanceof doc.defaultView.HTMLAnchorElement && !links.includes(candidate)) {
      links.push(candidate);
    }
  }

  /**
   * @param {MouseEvent} event
   * @returns {boolean}
   */
  function isPlainPrimaryClick(event) {
    return (
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.defaultPrevented
    );
  }

  /**
   * @param {HTMLAnchorElement} link
   * @param {MouseEvent} event
   */
  function onLinkClick(link, event) {
    if (!isPlainPrimaryClick(event)) return;

    // Only same-origin absolute paths are handled as SPA navigation.
    const href = link.getAttribute('href');
    if (!href || !href.startsWith('/') || href.startsWith('//')) return;

    event.preventDefault();
    win.history.pushState({}, '', href);
    if (onNavigate) onNavigate(href);
  }

  /** @type {Array<{ link: HTMLAnchorElement, handler: (event: MouseEvent) => void }>} */
  const entries = [];
  for (const link of links) {
    const handler = (/** @type {MouseEvent} */ event) => onLinkClick(link, event);
    link.addEventListener('click', handler);
    entries.push({ link, handler });
  }

  return {
    destroy() {
      for (const { link, handler } of entries) {
        link.removeEventListener('click', handler);
      }
      entries.length = 0;
    },
  };
}

/**
 * @typedef {Object} ViewToggleOptions
 * @property {Document} [document] Document that owns the toggle buttons.
 * @property {Window} [window] Window used to build keyboard events.
 * @property {(view: SpaceView) => void} [onSelect] Called when a view is activated.
 */

/**
 * @typedef {Object} ViewToggleController
 * @property {(view: SpaceView | string) => void} setView Updates pressed state and roving tabindex.
 * @property {() => SpaceView} getView Reports the active view.
 * @property {() => void} destroy Removes every listener.
 */

/**
 * Wire the list/map toggle as an accessible, URL-aware segmented control.
 *
 * The helper owns `aria-pressed`, the `is-active` class, the roving tabindex
 * and arrow/Home/End navigation. `onSelect` lets app.js update visibility and
 * the URL without the shell coupling to routing.
 *
 * @param {ViewToggleOptions} [options]
 * @returns {ViewToggleController}
 */
export function setupViewToggle(options = {}) {
  const doc = options.document ?? /** @type {Document} */ (globalThis.document);
  const win = options.window ?? /** @type {Window} */ (globalThis.window);
  const onSelect = options.onSelect;

  /** @type {HTMLButtonElement[]} */
  const buttons = Array.from(doc.querySelectorAll('.view-toggle-btn')).filter(
    element => element instanceof doc.defaultView.HTMLButtonElement
  );

  /** @type {SpaceView} */
  let currentView = 'list';

  /**
   * @param {SpaceView | string | null | undefined} view
   * @returns {SpaceView}
   */
  function normalize(view) {
    return view === 'map' ? 'map' : 'list';
  }

  /**
   * @param {SpaceView | string | null | undefined} view
   * @returns {SpaceView}
   */
  function setView(view) {
    currentView = normalize(view);
    for (const button of buttons) {
      const isActive = normalize(button.dataset.view) === currentView;
      button.setAttribute('aria-pressed', String(isActive));
      button.classList.toggle('is-active', isActive);
      button.setAttribute('tabindex', isActive ? '0' : '-1');
    }
    return currentView;
  }

  /**
   * @param {SpaceView} view
   */
  function activate(view) {
    setView(view);
    const target = buttons.find(button => normalize(button.dataset.view) === view);
    if (target) target.focus();
    if (onSelect) onSelect(view);
  }

  /**
   * @param {HTMLButtonElement} button
   * @param {KeyboardEvent} event
   */
  function onKeyDown(button, event) {
    if (buttons.length === 0) return;

    const index = buttons.indexOf(button);
    /** @type {HTMLButtonElement | undefined} */
    let next;

    if (event.key === 'ArrowRight') {
      next = buttons[(index + 1) % buttons.length];
    } else if (event.key === 'ArrowLeft') {
      next = buttons[(index - 1 + buttons.length) % buttons.length];
    } else if (event.key === 'Home') {
      next = buttons[0];
    } else if (event.key === 'End') {
      next = buttons[buttons.length - 1];
    } else {
      return;
    }

    if (!next) return;
    event.preventDefault();
    activate(normalize(next.dataset.view));
  }

  /** @type {Array<{ button: HTMLButtonElement, click: () => void, keydown: (event: KeyboardEvent) => void }>} */
  const entries = [];
  for (const button of buttons) {
    const onClick = () => activate(normalize(button.dataset.view));
    const onKey = (/** @type {KeyboardEvent} */ event) => onKeyDown(button, event);
    button.addEventListener('click', onClick);
    button.addEventListener('keydown', onKey);
    entries.push({ button, click: onClick, keydown: onKey });
  }

  // Seed the roving tabindex from the markup so the active view stays the only
  // tab stop even before the first user interaction.
  const pressed = buttons.find(button => button.getAttribute('aria-pressed') === 'true');
  setView(pressed ? pressed.dataset.view : 'list');

  return {
    setView,
    getView: () => currentView,
    destroy() {
      for (const entry of entries) {
        entry.button.removeEventListener('click', entry.click);
        entry.button.removeEventListener('keydown', entry.keydown);
      }
      entries.length = 0;
    },
  };
}

/**
 * Create the mobile navigation drawer controller for the current shell markup.
 *
 * @param {ShellOptions} [options]
 * @returns {ShellController}
 */
export function setupShell(options = {}) {
  const doc = options.document ?? /** @type {Document} */ (globalThis.document);
  const win = options.window ?? /** @type {Window} */ (globalThis.window);
  const onNavigate = options.onNavigate;

  const sidebar = doc.getElementById('sidebar');
  const overlay = doc.getElementById('sidebar-overlay');
  const hamburger = doc.getElementById('hamburger-btn');
  const sidebarClose = doc.getElementById('sidebar-close');
  const main = doc.getElementById('main-content');

  /** @type {boolean} */
  let openState = false;
  /** @type {boolean} */
  let destroyed = false;
  /** @type {Element | null} */
  let previousFocus = null;

  /**
   * @returns {boolean} True when the viewport is inside the mobile drawer range.
   */
  function isMobile() {
    if (typeof win.matchMedia === 'function') {
      return win.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
    }
    return typeof win.innerWidth === 'number' ? win.innerWidth <= 860 : false;
  }

  /**
   * @returns {HTMLElement[]} Focusable elements inside the drawer, in DOM order.
   */
  function getFocusable() {
    if (!sidebar) return [];
    /** @type {HTMLElement[]} */
    const elements = Array.from(sidebar.querySelectorAll(FOCUSABLE_SELECTOR));
    return elements.filter(isFocusable);
  }

  /**
   * @param {HTMLElement} element
   * @returns {boolean}
   */
  function isFocusable(element) {
    if (!(element instanceof doc.defaultView.Element)) return false;
    if (element.closest('[hidden]')) return false;
    if ('disabled' in element && element.disabled) return false;
    return true;
  }

  /**
   * @param {boolean} visible
   */
  function setOverlayVisible(visible) {
    if (!overlay) return;
    overlay.hidden = !visible;
    overlay.classList.toggle('overlay-hidden', !visible);
    overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  /**
   * @param {KeyboardEvent} event
   */
  function trapTab(event) {
    const focusable = getFocusable();
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = doc.activeElement;
    const inside = Boolean(active && sidebar && sidebar.contains(active));

    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (!inside || active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    if (!openState) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }

    if (event.key === 'Tab') {
      trapTab(event);
    }
  }

  function onOverlayClick() {
    close();
  }

  function onTriggerClick() {
    if (!isMobile()) return;
    if (openState) close();
    else open();
  }

  function onSidebarCloseClick() {
    close();
  }

  /**
   * Close on navigation while letting the click continue so app.js can route it.
   *
   * @param {MouseEvent} event
   */
  function onSidebarClick(event) {
    const target = event.target;
    if (!(target instanceof doc.defaultView.Element)) return;
    const anchor = target.closest('a[href]');
    if (!anchor || !sidebar || !sidebar.contains(anchor)) return;

    close();
    if (onNavigate) onNavigate(/** @type {HTMLAnchorElement} */ (anchor), event);
  }

  function onResize() {
    if (openState && !isMobile()) {
      close({ restoreFocus: false });
    }
  }

  /**
   * @returns {boolean}
   */
  function open() {
    if (destroyed || openState) return false;
    if (!sidebar) return false;

    openState = true;
    previousFocus = doc.activeElement;

    sidebar.classList.add('is-open', 'sidebar-open');
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    hamburger?.setAttribute('aria-expanded', 'true');
    main?.setAttribute('inert', '');
    doc.body.classList.add('drawer-open');
    setOverlayVisible(true);

    const target = sidebarClose ?? getFocusable()[0] ?? sidebar;
    target.focus();

    return true;
  }

  /**
   * @param {{ restoreFocus?: boolean }} [closeOptions]
   * @returns {boolean}
   */
  function close(closeOptions = {}) {
    const restoreFocus = closeOptions.restoreFocus !== false;
    if (!openState) return false;

    openState = false;

    sidebar?.classList.remove('is-open', 'sidebar-open');
    sidebar?.removeAttribute('role');
    sidebar?.removeAttribute('aria-modal');
    hamburger?.setAttribute('aria-expanded', 'false');
    main?.removeAttribute('inert');
    doc.body.classList.remove('drawer-open');
    setOverlayVisible(false);

    if (restoreFocus) {
      const fallback =
        previousFocus && 'focus' in previousFocus
          ? /** @type {HTMLElement} */ (previousFocus)
          : null;
      const target = hamburger ?? fallback;
      target?.focus();
    }

    previousFocus = null;
    return true;
  }

  function destroy() {
    if (destroyed) return;
    close({ restoreFocus: false });
    destroyed = true;

    hamburger?.removeEventListener('click', onTriggerClick);
    sidebarClose?.removeEventListener('click', onSidebarCloseClick);
    sidebar?.removeEventListener('click', onSidebarClick);
    overlay?.removeEventListener('click', onOverlayClick);
    doc.removeEventListener('keydown', onKeyDown);
    win.removeEventListener('resize', onResize);
  }

  hamburger?.addEventListener('click', onTriggerClick);
  sidebarClose?.addEventListener('click', onSidebarCloseClick);
  sidebar?.addEventListener('click', onSidebarClick);
  overlay?.addEventListener('click', onOverlayClick);
  doc.addEventListener('keydown', onKeyDown);
  win.addEventListener('resize', onResize);

  return {
    open,
    close,
    destroy,
    isOpen: () => openState,
  };
}
