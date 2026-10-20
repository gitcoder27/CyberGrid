import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Bridge } from '../engine/bridge.js';
import { TerminalWriter } from './writer.js';

const TERM_THEME = {
  background: '#05070b',
  foreground: '#c8d3e0',
  cursor: '#05070b',
  cursorAccent: '#05070b',
  selectionBackground: '#264f78',
};

/**
 * The terminal's output pane. xterm renders history only (stdin disabled);
 * typing happens in the native CommandLine, which handles paste, IME and
 * virtual keyboards. The WebGL renderer is loaded lazily after first paint —
 * the DOM renderer covers the boot sequence and any device without WebGL.
 */
export function TerminalView({ bridge, onWriter }: { bridge: Bridge; onWriter: (w: TerminalWriter | null) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  useEffect(() => {
    const host = hostRef.current!;
    const narrow = window.matchMedia('(max-width: 759px)').matches;
    const term = new Terminal({
      fontFamily:
        "'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'IBM Plex Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: narrow ? 12.5 : 14,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      disableStdin: true,
      scrollback: 4000,
      convertEol: false,
      theme: TERM_THEME,
      allowProposedApi: true,
      screenReaderMode: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // xterm's helper textarea must never steal focus from the command line.
    const helper = host.querySelector('textarea');
    if (helper) {
      helper.setAttribute('tabindex', '-1');
      helper.setAttribute('aria-hidden', 'true');
    }
    fit.fit();

    let disposed = false;
    const canWebgl = (() => {
      try {
        return !!document.createElement('canvas').getContext('webgl2');
      } catch {
        return false;
      }
    })();
    if (canWebgl) {
      const load = () =>
        import('@xterm/addon-webgl')
          .then(({ WebglAddon }) => {
            if (disposed) return;
            const addon = new WebglAddon();
            addon.onContextLoss(() => addon.dispose());
            term.loadAddon(addon);
          })
          .catch(() => {
            /* DOM renderer stays — still fine */
          });
      const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
      if (idle) idle(load);
      else window.setTimeout(load, 300);
    }

    const writer = new TerminalWriter(term, () => bridgeRef.current.snapshot.settings.typing);
    onWriter(writer);

    const resize = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* host not measurable yet */
      }
    });
    resize.observe(host);

    let raf = 0;
    const drain = () => {
      if (bridgeRef.current.printQueue.length) writer.enqueue(bridgeRef.current.printQueue.splice(0));
      raf = window.requestAnimationFrame(drain);
    };
    raf = window.requestAnimationFrame(drain);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(raf);
      resize.disconnect();
      onWriter(null);
      writer.dispose();
      term.dispose();
    };
  }, [onWriter]);

  return <div className="terminal-host" ref={hostRef} aria-hidden="true" />;
}
