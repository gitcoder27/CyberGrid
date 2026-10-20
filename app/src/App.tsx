import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { TopBar, MapPanel, IntelPanel, Dock } from './hud/Hud.js';
import { TerminalView } from './terminal/TerminalView.js';
import { CommandLine, type CommandLineHandle } from './terminal/CommandLine.js';
import type { TerminalWriter } from './terminal/writer.js';
import { Synth } from './audio/synth.js';
import { createLocalStorageAdapter } from './persistence/storage.js';
import { Bridge } from './engine/bridge.js';

let flashSeq = 0;

export function App() {
  const bridge = useMemo(() => new Bridge(createLocalStorageAdapter()), []);
  const synth = useMemo(() => new Synth(), []);
  const rootRef = useRef<HTMLDivElement>(null);
  const terminalBoxRef = useRef<HTMLDivElement>(null);
  const cmdRef = useRef<CommandLineHandle>(null);
  const writerRef = useRef<TerminalWriter | null>(null);
  const [flash, setFlash] = useState<{ kind: string; seq: number } | null>(null);
  const [drawer, setDrawer] = useState<'map' | 'intel' | null>(null);

  useSyncExternalStore(bridge.subscribe, bridge.getVersion, bridge.getVersion);

  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const motionAllowed = bridge.snapshot.settings.motion && !reducedMotion;
  const motionRef = useRef(motionAllowed);
  motionRef.current = motionAllowed;

  const onWriter = useCallback((w: TerminalWriter | null) => {
    writerRef.current = w;
  }, []);
  const getWriter = useCallback(() => writerRef.current, []);
  const backToCommand = useCallback(() => cmdRef.current?.focus(), []);

  /* ------------------------------ frame loop ------------------------------ */
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let hudClock = 0;
    let saveClock = 0;
    const loop = (now: number) => {
      // Capped: a background tab (no rAF) never fast-forwards the mission clock.
      const dt = Math.min(now - last, 100);
      last = now;
      bridge.frame(dt);
      const snap = bridge.snapshot;
      synth.applySettings(snap);
      const live = snap.mode === 'mission' ? snap.mission : null;
      synth.setAlarm(live && live.phase !== 'quiet' ? live.trace : null);

      for (const f of bridge.fxQueue.splice(0)) {
        if (f.kind === 'sfx' && f.name) synth.play(f.name as never);
        if (!motionRef.current) continue;
        if (f.kind === 'flash') setFlash({ kind: f.flashKind ?? 'good', seq: ++flashSeq });
        if (f.kind === 'shake') {
          const root = rootRef.current;
          if (root) {
            root.style.setProperty('--shake-px', `${Math.min(6, 2 + (f.power ?? 1) * 3)}px`);
            root.classList.remove('shake');
            void root.offsetWidth;
            root.classList.add('shake');
            window.setTimeout(() => root.classList.remove('shake'), 420);
          }
        }
        if (f.kind === 'glitch') {
          const box = terminalBoxRef.current;
          if (box) {
            box.classList.remove('glitch');
            void box.offsetWidth;
            box.classList.add('glitch');
            window.setTimeout(() => box.classList.remove('glitch'), 240);
          }
        }
      }
      // fuse / transfer timers tick without engine state events
      hudClock += dt;
      if (hudClock > 150) {
        hudClock = 0;
        if (snap.mode === 'mission') bridge.refresh();
      }
      saveClock += dt;
      if (saveClock > 5000) {
        saveClock = 0;
        if (snap.mode === 'mission') bridge.persist();
      }
      rootRef.current?.classList.toggle('shake-ambient', motionRef.current && !!live && live.phase === 'alert');
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [bridge, synth]);

  /* ---------------------------- persistence ------------------------------ */
  useEffect(() => {
    let hiddenMidRun = false;
    const save = () => bridge.persist();
    const onVisibility = () => {
      if (document.hidden) {
        bridge.persist();
        synth.setAlarm(null); // alarms never wail from a background tab
        hiddenMidRun = bridge.snapshot.mode === 'mission';
      } else if (hiddenMidRun) {
        hiddenMidRun = false;
        bridge.note('[‖] terminal was out of sight — the mission clock stopped with it.');
      }
    };
    window.addEventListener('blur', save);
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', save);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [bridge, synth]);

  useEffect(() => {
    const unlock = () => synth.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [synth]);

  // A drawer that opens takes focus; closing returns it to the command line.
  const toggleDrawer = (d: 'map' | 'intel') => {
    setDrawer((cur) => {
      const next = cur === d ? null : d;
      window.setTimeout(() => {
        if (next) document.querySelector<HTMLElement>(`#${next}-panel .drawer-close`)?.focus();
        else cmdRef.current?.focus();
      }, 0);
      return next;
    });
  };
  const closeDrawer = () => {
    setDrawer(null);
    window.setTimeout(() => cmdRef.current?.focus(), 0);
  };

  // A command composed from a drawer (e.g. "type `breach …`") hands the screen back to the command line.
  const composeSeq = bridge.compose?.seq ?? 0;
  useEffect(() => {
    if (composeSeq) setDrawer(null);
  }, [composeSeq]);

  const snap = bridge.snapshot;
  return (
    <div className={`app mode-${snap.mode} ${snap.mission?.cutscene ? 'cutscene' : ''} ${motionAllowed ? '' : 'no-motion'}`} ref={rootRef}>
      <a className="skip-link" href="#cmd">
        skip to command line
      </a>
      <TopBar snap={snap} bridge={bridge} onToggle={toggleDrawer} drawer={drawer} />
      <div className="main">
        <MapPanel bridge={bridge} snap={snap} open={drawer === 'map'} onClose={closeDrawer} backToCommand={backToCommand} />
        <main className="panel terminal-panel" ref={terminalBoxRef} aria-label="terminal">
          <div
            className="terminal-scroll"
            onPointerUp={() => {
              // click-to-type, unless the player is selecting text to copy
              if (!window.getSelection()?.toString()) cmdRef.current?.focus();
            }}
          >
            <TerminalView bridge={bridge} onWriter={onWriter} />
          </div>
          <Dock bridge={bridge} snap={snap} />
          <CommandLine ref={cmdRef} bridge={bridge} snap={snap} synth={synth} writer={getWriter} />
        </main>
        <IntelPanel bridge={bridge} snap={snap} open={drawer === 'intel'} onClose={closeDrawer} backToCommand={backToCommand} />
      </div>
      {drawer && <div className="scrim" onClick={closeDrawer} aria-hidden="true" />}
      <Transcript bridge={bridge} />
      <div role="status" aria-live="polite" className="sr-only" data-testid="announcer">
        {bridge.announcement.text}
      </div>
      {snap.settings.crt && <div className="crt-overlay" aria-hidden="true" />}
      {flash && <div key={flash.seq} className={`flash-layer ${flash.kind}`} aria-hidden="true" />}
    </div>
  );
}

/** Screen-reader / automation mirror of the terminal. Progress frames are excluded. */
function Transcript({ bridge }: { bridge: Bridge }) {
  const version = bridge.transcriptVersion;
  return useMemo(
    () => (
      <div role="log" aria-label="terminal output" className="sr-only" data-testid="transcript">
        {bridge.transcript.slice(-120).map((l) => (
          <p key={l.id}>{l.text}</p>
        ))}
      </div>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, bridge]
  );
}
