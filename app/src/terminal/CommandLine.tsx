import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Snapshot } from '@cybergrid/engine';
import type { Bridge } from '../engine/bridge.js';
import type { Synth } from '../audio/synth.js';
import type { TerminalWriter } from './writer.js';

export interface CommandLineHandle {
  focus(): void;
}

/**
 * The command line: a native <input> styled as the terminal prompt.
 *
 * - Enter submits exactly what is typed. On the results screen an EMPTY Enter
 *   retries (the engine decides that — F01); typed commands always run as typed.
 * - TAB fills the glowing suggestion, then completes verbs/paths/ips.
 * - Shift+TAB (or Esc then TAB) leaves the field, so keyboard users can reach
 *   the map and panels; nothing traps focus.
 * - Paste, IME composition and mobile keyboards work because the browser
 *   owns the text field.
 */
export const CommandLine = forwardRef<CommandLineHandle, { bridge: Bridge; snap: Snapshot; synth: Synth; writer: () => TerminalWriter | null }>(
  function CommandLine({ bridge, snap, synth, writer }, ref) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [value, setValue] = useState('');
    const [candidates, setCandidates] = useState<string[]>([]);
    const historyIdx = useRef<number | null>(null);
    const escArmed = useRef(false);
    const composing = useRef(false);

    useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

    // HUD controls compose commands here; they never execute them.
    const composeSeq = bridge.compose?.seq ?? 0;
    useEffect(() => {
      if (!bridge.compose) return;
      setValue(bridge.compose.text);
      setCandidates([]);
      inputRef.current?.focus();
    }, [composeSeq, bridge]);

    useEffect(() => {
      const t = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }, []);

    // A results screen that just appeared ignores a bare Enter for a beat, so a
    // player still hammering keys from the bust sequence reads the after-action
    // instead of retrying past it.
    const resultAt = useRef(0);
    const resultSeq = bridge.resultSeq;
    useEffect(() => {
      if (resultSeq) resultAt.current = performance.now();
    }, [resultSeq]);

    const submit = useCallback(
      (line: string) => {
        if (!line.trim() && bridge.snapshot.mode === 'post' && performance.now() - resultAt.current < 800) return;
        setValue('');
        setCandidates([]);
        historyIdx.current = null;
        writer()?.flush();
        bridge.submit(line);
      },
      [bridge, writer]
    );

    const complete = useCallback(() => {
      const suggest = bridge.snapshot.suggest;
      if (suggest && suggest.toLowerCase().startsWith(value.toLowerCase()) && value.length < suggest.length) {
        setValue(suggest);
        setCandidates([]);
        return;
      }
      const { items, from } = bridge.engine.complete(value);
      if (!items.length) {
        setCandidates([]);
        return;
      }
      if (items.length === 1) {
        setValue(value.slice(0, from) + items[0]!);
        setCandidates([]);
        return;
      }
      let prefix = items[0]!;
      for (const it of items) {
        let i = 0;
        while (i < prefix.length && i < it.length && prefix[i]!.toLowerCase() === it[i]!.toLowerCase()) i++;
        prefix = prefix.slice(0, i);
      }
      if (prefix.length > value.length - from) setValue(value.slice(0, from) + prefix);
      setCandidates(items.slice(0, 12));
    }, [bridge, value]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      synth.unlock();
      writer()?.flush(); // any keypress completes typewriter output (PRD §13)
      const s = bridge.snapshot;
      if (s.mode === 'boot') {
        bridge.submit('', { echo: false }); // any key skips the boot
        if (e.key === 'Enter') e.preventDefault();
        return;
      }
      if (s.mission?.cutscene) {
        // the bust sequence: a key shows the rest — it never also submits
        e.preventDefault();
        bridge.skipCutscene();
        return;
      }
      if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229) {
        // the IME owns this key — and Enter must not fall through to the form's implicit submit
        if (e.key === 'Enter') e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        if (value) {
          setValue('');
          setCandidates([]);
        }
        escArmed.current = true;
        return;
      }
      if (e.key === 'Tab') {
        if (e.shiftKey || escArmed.current || e.altKey || e.ctrlKey || e.metaKey) {
          escArmed.current = false;
          return; // let focus move on
        }
        e.preventDefault();
        complete();
        return;
      }
      escArmed.current = false;
      if (e.key === 'Enter') {
        e.preventDefault();
        submit(value.trim() ? value : '');
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const hist = bridge.engine.history;
        if (!hist.length) return;
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        if (historyIdx.current === null) {
          if (dir === 1) return;
          historyIdx.current = hist.length - 1;
        } else {
          historyIdx.current += dir;
          if (historyIdx.current >= hist.length) {
            historyIdx.current = null;
            setValue('');
            return;
          }
          historyIdx.current = Math.max(0, historyIdx.current);
        }
        setValue(hist[historyIdx.current] ?? '');
        return;
      }
      if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        bridge.submit('clear', { echo: false });
        return;
      }
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && inputRef.current?.selectionStart === inputRef.current?.selectionEnd) {
        e.preventDefault();
        setValue('');
        setCandidates([]);
      }
    };

    const suggest = snap.mode !== 'boot' ? snap.suggest : '';
    const ghost =
      suggest && suggest.toLowerCase().startsWith(value.toLowerCase()) && suggest.length > value.length ? suggest.slice(value.length) : '';
    const placeholder = snap.mode === 'boot' ? 'press any key' : '';

    return (
      <div className="cmdline-wrap">
        {candidates.length > 1 && (
          <div className="candidates" aria-live="polite">
            {candidates.join('   ')}
          </div>
        )}
        <form
          className="cmdline"
          onSubmit={(e) => {
            e.preventDefault();
            submit(value);
          }}
        >
          <label htmlFor="cmd" className="prompt">
            {snap.prompt}
          </label>
          <div className="cmd-field">
            <input
              id="cmd"
              ref={inputRef}
              className="cmd-input"
              data-testid="command-input"
              type="text"
              value={value}
              maxLength={200}
              placeholder={placeholder}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="send"
              aria-describedby={ghost ? 'cmd-suggest' : undefined}
              onChange={(e) => {
                const next = e.target.value.replace(/[\r\n]+/g, ' ');
                if (next.length > value.length) synth.keyclick();
                setValue(next);
                if (candidates.length) setCandidates([]);
                historyIdx.current = null;
              }}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
              onKeyDown={onKeyDown}
            />
            {ghost && (
              <span className="ghost" aria-hidden="true" style={{ left: `${[...value].length}ch` }}>
                {ghost}
              </span>
            )}
          </div>
          {suggest ? (
            <span id="cmd-suggest" className="sr-only">
              suggestion: {suggest}. press tab to fill.
            </span>
          ) : null}
          <button
            type="button"
            className="cmd-btn"
            onClick={() => {
              complete();
              inputRef.current?.focus();
            }}
            aria-label={suggest ? `fill suggestion: ${suggest}` : 'complete command'}
            title="TAB — fill suggestion / complete"
          >
            ⇥
          </button>
          <button type="submit" className="cmd-btn" aria-label="run command" title="Enter">
            ⏎
          </button>
        </form>
      </div>
    );
  }
);
