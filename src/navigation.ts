import { flushSync } from "react-dom";

export type NavigationDirection = "forward" | "back";

type ViewTransition = {
  finished: Promise<void>;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => ViewTransition;
};

type NavigationHistoryState = {
  prismDirection?: NavigationDirection;
  prismSynthetic?: boolean;
};

function prefersReducedMotion() {
  return document.documentElement.dataset.reduceMotion === "true"
    || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function clearNavigationDirection(direction: NavigationDirection) {
  const root = document.documentElement;
  if (root.dataset.navigationDirection === direction) delete root.dataset.navigationDirection;
}

function commitRouteUpdate(update: () => void) {
  // View Transition snapshots are taken as soon as the update callback
  // returns. Flush the small route state update so React's new DOM is ready
  // before Chromium captures the new state.
  flushSync(update);
}

/**
 * Update a route with Chromium's native View Transitions API when available.
 * The fallback deliberately keeps the animation short and only fades the route
 * stage, so older Chromium builds and reduced-motion users remain responsive.
 */
export function runRouteTransition(update: () => void, direction: NavigationDirection = "forward") {
  const root = document.documentElement;
  root.dataset.navigationDirection = direction;

  if (prefersReducedMotion()) {
    commitRouteUpdate(update);
    clearNavigationDirection(direction);
    return;
  }

  const startViewTransition = (document as ViewTransitionDocument).startViewTransition;
  if (typeof startViewTransition === "function") {
    try {
      const transition = startViewTransition.call(document, () => commitRouteUpdate(update));
      void transition.finished.catch(() => undefined).finally(() => clearNavigationDirection(direction));
      return;
    } catch {
      // Some Chromium builds expose the method but reject it while the document
      // is being torn down. Continue with the lightweight fallback below.
    }
  }

  root.classList.remove("prism-route-fallback");
  commitRouteUpdate(update);
  window.requestAnimationFrame(() => {
    root.classList.add("prism-route-fallback");
    window.setTimeout(() => root.classList.remove("prism-route-fallback"), 190);
  });
  window.setTimeout(() => clearNavigationDirection(direction), 190);
}

export function pushRoute(path: string, direction: NavigationDirection = "forward") {
  window.history.pushState({ prismDirection: direction } satisfies NavigationHistoryState, "", path);
  window.dispatchEvent(new PopStateEvent("popstate", {
    state: { prismDirection: direction, prismSynthetic: true } satisfies NavigationHistoryState
  }));
}

export function replaceRoute(path: string) {
  window.history.replaceState({}, "", path);
}

export function directionFromPopState(event: PopStateEvent): NavigationDirection {
  const state = event.state as NavigationHistoryState | null;
  return state?.prismSynthetic && state.prismDirection === "forward" ? "forward" : "back";
}
