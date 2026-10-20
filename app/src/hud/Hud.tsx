import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '@cybergrid/engine';
import type { Bridge } from '../engine/bridge.js';

/**
 * HUD v1 (PRD §14): peripheral glow around the terminal — trace meter up top,
 * network map left, objectives + tools + handler chat right. Clicking a map node
 * focuses it (prints intel) but never acts; the terminal is the only verb instrument.
 */

export function TopBar({ snap, bridge }: { snap: Snapshot; bridge: Bridge }) {
  const trace = snap.mission?.trace ?? 0;
  const phase = snap.mission?.phase ?? 'quiet';
  const fillClass = phase === 'alert' ? 'alert' : phase === 'watchdog' ? 'hot' : '';
  const inMission = !!snap.mission && snap.mode === 'mission';

  return (
    <header className="topbar">
      <div className="brand">CYBERGRID</div>
      <div className="mission-title">
        {snap.mission && snap.mode !== 'home' ? (
          <>
            <span className="codename">{snap.mission.codename}</span>{' '}
            <span className="seed">· {snap.mission.seed}</span>
          </>
        ) : (
          <span className="seed">burner terminal · home grid</span>
        )}
      </div>
      {inMission && (
        <div className="trace-wrap" aria-label="trace meter">
          <span className="trace-label">TRACE</span>
          <div className="trace-bar">
            <div
              className={`trace-fill ${fillClass}`}
              style={{ width: `${trace}%` }}
            />
            <span className="trace-mark" style={{ left: '50%' }} />
            <span className="trace-mark" style={{ left: '75%' }} />
          </div>
          <span className={`trace-pct ${fillClass}`}>{trace}%</span>
        </div>
      )}
      <div className="cash">${snap.profile.cash.toLocaleString()}</div>
      <div className="rank-chip">{snap.profile.rank}</div>
      <button
        className="mute-btn"
        onClick={() => bridge.submit(`settings mute ${snap.settings.muted ? 'off' : 'on'}`)}
        title={snap.settings.muted ? 'unmute (settings mute off)' : 'mute (settings mute on)'}
        aria-label={snap.settings.muted ? 'unmute' : 'mute'}
      >
        {snap.settings.muted ? '🔇' : '🔊'}
      </button>
    </header>
  );
}

export function NodeMap({ bridge, snap }: { bridge: Bridge; snap: Snapshot }) {
  const m = snap.mission;
  return (
    <section className="panel">
      <div className="panel-title">NETWORK MAP</div>
      <div className="nodemap">
        {!m && <div className="map-hint">no active run. accept a contract from the board.</div>}
        {m &&
          m.nodes.map((n, i) => (
            <div
              key={n.id}
              className={`node ${n.status} ${n.isCurrent ? 'current' : ''}`}
              onClick={() => bridge.focusNode(n.id)}
              title="focus node"
            >
              <div className="hostname">{n.hostname}</div>
              <div className="ip">
                {n.ip} · sec {n.security}
              </div>
              {n.scanned && (
                <div className="meta">
                  loot ~${n.lootValue}
                  {n.logsLeft > 0 ? ` · logs ${n.logsLeft}` : ''}
                  {i < m.nodes.length - 1 ? ' ┐' : ''}
                </div>
              )}
              <div className="badges">
                {n.isCurrent && <span className="badge you">YOU</span>}
                {n.hasTarget && n.scanned && <span className="badge target">⚑ {m.targets.filter((t) => t.nodeId === n.id && !t.stolen).length}</span>}
                {m.watchdogNodeId === n.id && <span className="badge watchdog">WATCHDOG</span>}
              </div>
            </div>
          ))}
        {m && <div className="map-hint">click a node to focus — the terminal still acts.</div>}
      </div>
    </section>
  );
}

export function SidePanel({ bridge, snap }: { bridge: Bridge; snap: Snapshot }) {
  const m = snap.mission;
  return (
    <aside className="side">
      <section className="panel">
        <div className="panel-title">OBJECTIVES</div>
        <div className="objectives">
          {!m && <div className="map-hint">no contract running.</div>}
          {m?.targets.map((t) => (
            <div key={t.id} className={`obj ${t.stolen ? 'done' : ''}`}>
              <span className="tick">{t.stolen ? '■' : '□'}</span>
              <span>
                {t.name} <span className="where">· {m.nodes.find((n) => n.id === t.nodeId)?.hostname ?? t.nodeId}</span>
              </span>
            </div>
          ))}
          {m && (
            <div className="obj">
              <span className="tick">▸</span>
              <span>
                {m.stolen}/{m.required} stolen · session ${m.sessionCash} · {m.sessionXp} xp
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">TOOLS</div>
        <div className="tools">
          <div className={`tool ${m && m.tools.proxy === 0 ? 'spent' : ''}`}>
            <span>proxy hop</span>
            <span className="cnt">×{m?.tools.proxy ?? 0} · −25 trace</span>
          </div>
          <div className={`tool ${m && m.tools.decoy === 0 ? 'spent' : ''}`}>
            <span>decoy</span>
            <span className="cnt">×{m?.tools.decoy ?? 0} · blinds watchdog</span>
          </div>
          {m && m.logsLeft > 0 && (
            <div className="tool">
              <span>logs on chain</span>
              <span className="cnt">×{m.logsLeft} · rm = −8 trace</span>
            </div>
          )}
        </div>
      </section>

      <HandlerPanel bridge={bridge} />

      {snap.lastResult && snap.mode === 'post' && (
        <section className={`panel outcome-chip ${snap.lastResult.outcome}`}>
          <div>
            {snap.lastResult.outcome === 'clean' && `CLEAN EXIT · ${snap.lastResult.filesStolen}/${snap.lastResult.filesRequired} files · +$${snap.lastResult.cash}`}
            {snap.lastResult.outcome === 'messy' && `HOT EXIT · ${snap.lastResult.filesStolen}/${snap.lastResult.filesRequired} files · +$${snap.lastResult.cash}`}
            {snap.lastResult.outcome === 'busted' && 'BUSTED · loot lost'}
          </div>
          <div className="hint">[ENTER] retry same seed · `contracts` for the board</div>
        </section>
      )}
    </aside>
  );
}

function HandlerPanel({ bridge }: { bridge: Bridge }) {
  const [messages, setMessages] = useState<string[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (bridge.handlerQueue.length) {
        const incoming = bridge.handlerQueue.splice(0).filter((t) => t.length > 0);
        if (incoming.length) {
          setMessages((prev) => {
            // guidance ("Next: …") is transient — a new one replaces the old so
            // the panel never contradicts the current game state
            const kept = prev.filter(
              (m) => !m.startsWith('Next:') && !m.startsWith('Lock re-armed')
            );
            return [...kept, ...incoming].slice(-5);
          });
        }
      }
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [bridge]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [messages]);

  return (
    <section className="panel" style={{ flex: 1 }}>
      <div className="panel-title">HANDLER</div>
      <div className="handler" ref={boxRef}>
        {messages.map((msg, i) => (
          <div key={i} className="msg">
            {msg}
          </div>
        ))}
        {messages.length === 0 && <div className="map-hint">the broker is quiet.</div>}
      </div>
    </section>
  );
}
