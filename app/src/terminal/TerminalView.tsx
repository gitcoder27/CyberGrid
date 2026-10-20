import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { Bridge } from '../engine/bridge.js';
import type { Synth } from '../audio/synth.js';
import { TerminalWriter } from './writer.js';

const TERM_THEME = {
  background: '#05070b',
  foreground: '#c8d3e0',
  cursor: '#57d7ff',
  cursorAccent: '#05070b',
  selectionBackground: '#264f78',
};

export function TerminalView({
  bridge,
  synth,
  onJuice,
}: {
  bridge: Bridge;
  synth: Synth;
  onJuice?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef('');
  const historyIdx = useRef<number | null>(null);
  const writerRef = useRef<TerminalWriter | null>(null);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  useEffect(() => {
    const host = hostRef.current!;
    const term = new Terminal({
      fontFamily:
        "'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'IBM Plex Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: 14.5,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 4000,
      convertEol: false,
      theme: TERM_THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL unavailable — xterm falls back to the DOM renderer, still fine
    }
    fit.fit();

    const writer = new TerminalWriter(
      term as unknown as { write: (d: string) => void; clear: () => void; scrollToBottom: () => void },
      bridgeRef.current,
      () => inputRef.current
    );
    writerRef.current = writer;

    const resize = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* host not measurable yet */
      }
    });
    resize.observe(host);

    const rewriteInput = () => writer.drawInput();

    const doSubmit = () => {
      const line = inputRef.current;
      inputRef.current = '';
      historyIdx.current = null;
      writer.submit();
      bridgeRef.current.submit(line);
    };

    // Clipboard paste arrives here (multi-character data with no keydown).
    // Keys themselves are handled in the keydown handler below — that path sees
    // every keystroke reliably; xterm's onData delivery drops characters like
    // space in this setup (regression: `breach 10.0.0.12` typed as
    // `breach10.0.0.12`).
    term.onData((data) => {
      synth.unlock();
      writer.flush(); // any input completes typewriter output (PRD §13)
      const snap = bridgeRef.current.snapshot;
      if (snap.mode === 'boot') {
        bridgeRef.current.submit(''); // any input skips the boot sequence
        return;
      }
      if (data.length <= 1) return; // single chars came from the keydown path
      let changed = false;
      for (const ch of data) {
        // strip control characters (incl. newlines — pasted lines never
        // auto-execute; surprise execution is a footgun)
        if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) continue;
        inputRef.current = (inputRef.current + ch).slice(0, 200);
        changed = true;
      }
      if (changed) {
        synth.keyclick();
        rewriteInput();
      }
    });

    const doTab = () => {
      const snap = bridgeRef.current.snapshot;
      const input = inputRef.current;
      // Tutorial: TAB fills the glowing suggestion (PRD §11)
      if (snap.suggest && snap.suggest.toLowerCase().startsWith(input.toLowerCase()) && input.length < snap.suggest.length) {
        inputRef.current = snap.suggest;
        rewriteInput();
        return;
      }
      const { items, from } = bridgeRef.current.engine.complete(input);
      if (!items.length) return;
      if (items.length === 1) {
        inputRef.current = input.slice(0, from) + items[0]!;
      } else {
        let prefix = items[0]!;
        for (const it of items) {
          let i = 0;
          while (i < prefix.length && i < it.length && prefix[i] === it[i]) i++;
          prefix = prefix.slice(0, i);
        }
        if (prefix.length > input.length - from) {
          inputRef.current = input.slice(0, from) + prefix;
        }
        writer.newline();
        writer.enqueue([
          { t: 'print', text: items.slice(0, 12).join('   '), cls: 'dim', style: 'instant' },
        ]);
      }
      rewriteInput();
    };

    const historyGo = (dir: -1 | 1) => {
      const hist = bridgeRef.current.engine.history;
      if (!hist.length) return;
      if (historyIdx.current === null) {
        historyIdx.current = dir === -1 ? hist.length - 1 : 0;
      } else {
        historyIdx.current = Math.max(0, Math.min(hist.length - 1, historyIdx.current + dir));
      }
      inputRef.current = hist[historyIdx.current] ?? '';
      rewriteInput();
    };

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return false;
      synth.unlock();
      writer.flush(); // any keypress completes typewriter output (PRD §13)
      const snap = bridgeRef.current.snapshot;

      if (snap.mode === 'boot') {
        bridgeRef.current.submit(''); // any key skips the boot sequence
        return false;
      }
      if (snap.mode === 'post' && ev.key === 'Enter') {
        bridgeRef.current.submit('retry'); // one-keypress instant retry (PRD §7)
        writer.submit();
        return false;
      }
      if (ev.key === 'Enter') {
        doSubmit();
        return false;
      }
      if (ev.key === 'Tab') {
        ev.preventDefault();
        doTab();
        return false;
      }
      if (ev.key === 'Backspace') {
        inputRef.current = inputRef.current.slice(0, -1);
        rewriteInput();
        return false;
      }
      if (ev.key === 'ArrowUp') {
        historyGo(-1);
        return false;
      }
      if (ev.key === 'ArrowDown') {
        historyGo(1);
        return false;
      }
      if (ev.ctrlKey && (ev.key === 'l' || ev.key === 'L')) {
        bridgeRef.current.submit('clear');
        return false;
      }
      if (ev.ctrlKey && (ev.key === 'c' || ev.key === 'C')) {
        inputRef.current = '';
        rewriteInput();
        return false;
      }
      if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        // Keys are handled right here — the only path guaranteed to see every
        // keystroke, space included (see the onData note above).
        synth.keyclick(); // mechanical keyclick on every keystroke (PRD §13)
        inputRef.current = (inputRef.current + ev.key).slice(0, 200);
        rewriteInput();
        return false;
      }
      return true;
    });

    host.addEventListener('pointerdown', () => setTimeout(() => term.focus(), 0));
    setTimeout(() => term.focus(), 100);

    return () => {
      resize.disconnect();
      writer.dispose();
      term.dispose();
      writerRef.current = null;
    };
  }, [synth, onJuice]);

  // drain the bridge print queue into the writer at frame cadence
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const w = writerRef.current;
      if (w && bridgeRef.current.printQueue.length) {
        w.enqueue(bridgeRef.current.printQueue.splice(0));
      }
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  return <div className="terminal-host" ref={hostRef} />;
}
