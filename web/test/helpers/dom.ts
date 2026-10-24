import { Window } from 'happy-dom';

export interface DomHarness {
  window: Window;
  document: Document;
  cleanup: () => void;
}

/**
 * Installs a fresh happy-dom window as the test globals and returns a cleanup
 * that restores the previous globals. Each test should call `cleanup` when done
 * so DOM state cannot leak between tests.
 */
export function installDom(): DomHarness {
  const window = new Window({ url: 'http://localhost/' });
  const previous = {
    window: Reflect.get(globalThis, 'window'),
    document: Reflect.get(globalThis, 'document'),
    navigator: Reflect.get(globalThis, 'navigator'),
  };

  Reflect.set(globalThis, 'window', window);
  Reflect.set(globalThis, 'document', window.document);
  Reflect.set(globalThis, 'navigator', window.navigator);

  return {
    window,
    document: window.document as unknown as Document,
    cleanup() {
      Reflect.set(globalThis, 'window', previous.window);
      Reflect.set(globalThis, 'document', previous.document);
      Reflect.set(globalThis, 'navigator', previous.navigator);
      window.close();
    },
  };
}
