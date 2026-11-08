// The few WebExtension APIs the extension uses, typed by hand (no @types/chrome to install).
// Chromium (Chrome, Edge, Brave, Opera) and Firefox both answer these with promises in Manifest V3.

declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: tabs.Tab;
      frameId?: number;
      url?: string;
      origin?: string;
      id?: string;
    }
    const id: string;
    function getURL(path: string): string;
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    const onMessage: {
      addListener(
        fn: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | undefined,
      ): void;
    };
  }
  namespace storage {
    interface Area {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: Area;
    /** Memory only, gone when the browser closes (Chromium 102+, Firefox 115+). */
    const session: Area | undefined;
  }
  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
    }
    function query(q: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function get(id: number): Promise<Tab>;
    function sendMessage<T = unknown>(
      tabId: number,
      message: unknown,
      options?: { frameId?: number },
    ): Promise<T>;
  }
  namespace scripting {
    function executeScript(o: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  }
  namespace alarms {
    function create(name: string, o: { delayInMinutes: number }): Promise<void> | void;
    function clear(name: string): Promise<boolean>;
    const onAlarm: { addListener(fn: (a: { name: string }) => void): void };
  }
  /** Chromium only: a hidden page that may write the clipboard. */
  namespace offscreen {
    function createDocument(o: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
    function closeDocument(): Promise<void>;
  }
  namespace i18n {
    function getUILanguage(): string;
  }
}
