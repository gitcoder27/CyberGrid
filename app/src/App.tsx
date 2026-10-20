import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { TopBar, NodeMap, SidePanel } from './hud/Hud.js';
import { TerminalView } from './terminal/TerminalView.js';
import { Synth } from './audio/synth.js';
import { localStorageAdapter } from './persistence/storage.js';
import { Bridge } from './engine/bridge.js';

export function App() {
  const bridge = useMemo(() => new Bridge(localStorageAdapter), []);
  const synth = useMemo(() => new Synth(), []);
  const rootRef = useRef<HTMLDivElement>(null);
  const terminalBoxRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<{ kind: string; seq: number } | null>(null);

  // HUD re-renders when the bridge bumps its version
  useSyncExternalStore(bridge.subscribe, bridge.getVersion, bridge.getVersion);

  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const motionAllowed = bridge.snapshot.settings.motion && !reducedMotion;

  /* ------------------------------ frame loop ------------------------------ */
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let hudClock = 0;
    let saveClock = 0;

    const loop = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      bridge.frame(dt);

      // audio: alarm pitch follows the trace meter (PRD §13)
      const snap = bridge.snapshot;
      synth.applySettings(snap);
      const missionLive = snap.mode === 'mission' && snap.mission;
      const alarmTrace = missionLive && snap.mission!.phase !== 'quiet' ? snap.mission!.trace : null;
      synth.setAlarm(alarmTrace);

      // juice: fx queue
      const fx = bridge.fxQueue.splice(0);
      for (const f of fx) {
        if (f.kind === 'sfx' && f.name) synth.play(f.name as never);
        if (f.kind === 'flash') {
          setFlash({ kind: f.flashKind ?? 'good', seq: ++flashSeq });
        }
        if (f.kind === 'shake' && motionAllowed) {
          const root = rootRef.current;
          if (root) {
            root.style.setProperty('--shake-px', `${Math.min(6, 2 + (f.power ?? 1) * 3)}px`);
            root.classList.remove('shake');
            void root.offsetWidth;
            root.classList.add('shake');
            window.setTimeout(() => root.classList.remove('shake'), 420);
          }
        }
        if (f.kind === 'glitch' && motionAllowed) {
          const box = terminalBoxRef.current;
          if (box) {
            box.classList.remove('glitch');
            void box.offsetWidth;
            box.classList.add('glitch');
            window.setTimeout(() => box.classList.remove('glitch'), 240);
          }
        }
      }

      // HUD timers (puzzle fuse, transfer) tick even without engine state events
      hudClock += dt;
      if (hudClock > 150) {
        hudClock = 0;
        bridge.refresh();
      }

      // autosave the in-flight session periodically (crash safety, PRD §4.3)
      saveClock += dt;
      if (saveClock > 5000) {
        saveClock = 0;
        if (bridge.snapshot.mode === 'mission') bridge.persist();
      }

      // ambient shake while the admin alert is live (PRD §7: 75%)
      const root = rootRef.current;
      if (root) {
        const wantAmbient = motionAllowed && !!missionLive && bridge.snapshot.mission!.phase === 'alert';
        root.classList.toggle('shake-ambient', wantAmbient);
      }

      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [bridge, synth, motionAllowed]);

  /* ---------------------------- persistence ------------------------------ */
  useEffect(() => {
    const onBlur = () => bridge.persist(); // autosave on tab blur (PRD §4.3)
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [bridge]);

  // Alarms must not wail from a background tab (UAT finding): rAF stops when
  // hidden, so explicitly silence the loop until we're visible again.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) synth.setAlarm(null);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [synth]);

  useEffect(() => {
    const snap = bridge.snapshot;
    // unlock audio on the first interaction (autoplay policy, PRD §19)
    const unlock = () => synth.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    void snap;
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [synth, bridge]);

  const snap = bridge.snapshot;
  const showSuggest = snap.suggest.length > 0 && snap.mode !== 'boot';

  return (
    <div className="app" ref={rootRef}>
      <TopBar snap={snap} bridge={bridge} />
      <div className="main">
        <NodeMap bridge={bridge} snap={snap} />
        <div className="panel terminal-panel" ref={terminalBoxRef}>
          <TerminalView bridge={bridge} synth={synth} />
          {showSuggest && (
            <div className="suggest-chip" title="press TAB to fill">
              <span className="kbd">next ▸</span> {snap.suggest}
              <span className="kbd">[TAB]</span>
            </div>
          )}
        </div>
        <SidePanel bridge={bridge} snap={snap} />
      </div>
      {snap.settings.crt && <div className="crt-overlay" aria-hidden />}
      {flash && (
        <div key={flash.seq} className={`flash-layer ${flash.kind}`} aria-hidden />
      )}
    </div>
  );
}

let flashSeq = 0;
