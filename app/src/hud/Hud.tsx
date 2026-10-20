import { useEffect, useRef, useState } from 'react';
import { OUTCOME_LABEL } from '@cybergrid/engine';
import type { NodeView, Snapshot } from '@cybergrid/engine';
import { GUIDANCE_RESET, type Bridge } from '../engine/bridge.js';

/**
 * HUD (PRD §14, E01, F09): the urgent state is always visible — trace with its
 * source and the clean-exit line up top, the lock and transfer docked above the
 * command line, objective and tools beside it. Map nodes are buttons that
 * *inspect*; any action they offer only composes a command for the player.
 */

type Mission = NonNullable<Snapshot['mission']>;

const fmtRate = (r: number) => (r >= 0 ? `+${r.toFixed(r < 1 ? 2 : 1)}/s` : `${r.toFixed(1)}/s`);
const PHASE_LABEL = { quiet: 'QUIET', watchdog: 'WATCHDOG', alert: 'ADMIN ALERT' } as const;

/* ================================ top bar ================================ */

export function TopBar({
  snap,
  bridge,
  onToggle,
  drawer,
}: {
  snap: Snapshot;
  bridge: Bridge;
  onToggle: (d: 'map' | 'intel') => void;
  drawer: 'map' | 'intel' | null;
}) {
  const m = snap.mode === 'mission' ? snap.mission : null;
  return (
    <header className="topbar">
      <div className="brand" aria-hidden="true">
        CYBERGRID
      </div>
      <div className="mission-title">
        {m ? (
          <>
            <span className="codename">{m.codename}</span> <span className="seed">· {m.isTutorial ? 'warm-up' : m.name}</span>
          </>
        ) : (
          <span className="seed">burner terminal · home grid</span>
        )}
      </div>
      {m ? <TraceMeter m={m} /> : <div className="trace-spacer" />}
      <div className="cash" aria-label={`cash ${snap.profile.cash} dollars`}>
        ${snap.profile.cash.toLocaleString()}
      </div>
      <div className="rank-chip">{snap.profile.rank}</div>
      <div className="top-buttons">
        <button
          type="button"
          className="top-btn drawer-btn map-btn"
          aria-expanded={drawer === 'map'}
          aria-controls="map-panel"
          onClick={() => onToggle('map')}
        >
          map
        </button>
        <button
          type="button"
          className="top-btn drawer-btn intel-btn"
          aria-expanded={drawer === 'intel'}
          aria-controls="intel-panel"
          onClick={() => onToggle('intel')}
        >
          intel
        </button>
        <button
          type="button"
          className="top-btn"
          onClick={() => bridge.submit(`settings mute ${snap.settings.muted ? 'off' : 'on'}`, { echo: false })}
          aria-label={snap.settings.muted ? 'unmute sound' : 'mute sound'}
          aria-pressed={snap.settings.muted}
          title={snap.settings.muted ? 'settings mute off' : 'settings mute on'}
        >
          {snap.settings.muted ? '🔇' : '🔊'}
        </button>
      </div>
    </header>
  );
}

function TraceMeter({ m }: { m: Mission }) {
  const fill = m.phase === 'alert' ? 'alert' : m.phase === 'watchdog' ? 'hot' : '';
  return (
    <div className="trace-wrap" data-testid="trace">
      <div className="trace-row">
        <span className="trace-label">TRACE</span>
        <div
          className="trace-bar"
          role="meter"
          aria-label="trace"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={m.trace}
          aria-valuetext={`${m.trace} percent, ${PHASE_LABEL[m.phase]}`}
        >
          <div className={`trace-fill ${fill}`} style={{ width: `${Math.min(100, m.traceExact)}%` }} />
          <span className="trace-mark clean" style={{ left: `${m.cleanExitUnder}%` }} />
          <span className="trace-mark" style={{ left: '75%' }} />
        </div>
        <span className={`trace-pct ${fill}`}>{m.trace}%</span>
      </div>
      <div className="trace-sub">
        <span className={`phase ${fill}`}>{PHASE_LABEL[m.phase]}</span>
        <span className="rate">
          {m.traceRate > 0 ? fmtRate(m.traceRate) : '±0'} {m.traceSource}
        </span>
        <span className={m.cleanExitAvailable ? 'clean-ok' : 'clean-lost'}>
          {m.cleanExitAvailable ? `clean exit ✓ <${m.cleanExitUnder}` : `clean exit ✗ ≥${m.cleanExitUnder}`}
        </span>
      </div>
    </div>
  );
}

/* ================================== map ================================== */

const ROW_PX = 66;

export function MapPanel({
  bridge,
  snap,
  open,
  onClose,
  backToCommand,
}: {
  bridge: Bridge;
  snap: Snapshot;
  open: boolean;
  onClose: () => void;
  backToCommand: () => void;
}) {
  const m = snap.mode === 'mission' ? snap.mission : null;
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [m?.code, m?.name]);
  const node = m && selected ? m.nodes.find((n) => n.id === selected) ?? null : null;
  const scanned = !!m?.nodes[0]?.scanned;

  return (
    <section
      id="map-panel"
      className={`panel map-panel drawer drawer-left ${open ? 'open' : ''}`}
      aria-label="network map"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          if (selected) setSelected(null);
          else onClose();
          backToCommand();
        }
      }}
    >
      <div className="panel-title">
        <span>NETWORK MAP</span>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="close map">
          ✕
        </button>
      </div>
      <div className="nodemap">
        {!m && <p className="map-hint">no active run. accept a contract from the board.</p>}
        {m && !scanned && (
          <p className="map-hint">
            no recon yet — <code>scan</code> maps every node and link.
          </p>
        )}
        {m && scanned && <Graph m={m} selected={selected} onSelect={(id) => setSelected(id === selected ? null : id)} />}
        {m && scanned && !node && <p className="map-hint">select a node to inspect it. the terminal still does the work.</p>}
        {m && node && <NodeDetail m={m} node={node} bridge={bridge} onBack={backToCommand} />}
      </div>
    </section>
  );
}

function Graph({ m, selected, onSelect }: { m: Mission; selected: string | null; onSelect: (id: string) => void }) {
  const rows = Math.max(...m.nodes.map((n) => n.depth)) + 1;
  const lanes = new Set(m.nodes.map((n) => n.lane)).size;
  const single = lanes === 1;
  const x = (n: NodeView) => (single ? 50 : ((n.lane + 0.5) / 3) * 100);
  const y = (n: NodeView) => n.depth * ROW_PX + ROW_PX / 2;
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  const owned = (n: NodeView) => n.status !== 'locked';
  return (
    <div className={`graph ${single ? 'single' : 'forked'}`} style={{ height: rows * ROW_PX }}>
      <svg className="edges" viewBox={`0 0 100 ${rows * ROW_PX}`} preserveAspectRatio="none" aria-hidden="true">
        {m.edges.map(([a, b]) => {
          const na = byId.get(a);
          const nb = byId.get(b);
          if (!na || !nb) return null;
          const cls = owned(na) && owned(nb) ? 'owned' : (owned(na) && nb.frontier) || (owned(nb) && na.frontier) ? 'open' : 'dark';
          return <line key={`${a}-${b}`} className={cls} x1={x(na)} y1={y(na)} x2={x(nb)} y2={y(nb)} vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
      {m.nodes.map((n) => {
        const wd = m.watchdogNodeId === n.id;
        const label = [
          n.hostname,
          n.ip,
          n.status === 'entry' ? 'foothold' : n.status === 'breached' ? 'owned' : `locked, security ${n.security} ${n.lockFamily ?? ''}`,
          n.isCurrent ? 'you are here' : '',
          n.reachable ? `breachable from here, plus ${n.breachCost} trace` : '',
          n.objectiveRole ? `objective: ${n.objectiveRole}` : '',
          n.vault ? 'vault, optional' : '',
          wd ? 'watchdog here' : '',
        ]
          .filter(Boolean)
          .join(', ');
        return (
          <button
            key={n.id}
            type="button"
            className={`node ${n.status} ${n.isCurrent ? 'current' : ''} ${n.reachable ? 'reachable' : ''} ${n.vault ? 'vault' : ''} ${
              selected === n.id ? 'selected' : ''
            }`}
            style={{ left: `${x(n)}%`, top: y(n) }}
            aria-pressed={selected === n.id}
            aria-label={label}
            onClick={() => onSelect(n.id)}
          >
            <span className="hostname">{n.hostname}</span>
            <span className="meta">
              {n.status === 'entry'
                ? 'entry'
                : n.status === 'breached'
                  ? 'owned'
                  : `s${n.security} ${n.lockFamily === 'portknock' ? 'knock' : n.lockFamily === 'cipher' ? 'ciph' : 'seq'} +${n.breachCost}`}
            </span>
            <span className="badges" aria-hidden="true">
              {n.isCurrent && <span className="badge you">YOU</span>}
              {n.objectiveRole && <span className="badge target">⚑</span>}
              {n.vault && <span className="badge vault">$$</span>}
              {wd && <span className="badge watchdog">WD</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function NodeDetail({ m, node, bridge, onBack }: { m: Mission; node: NodeView; bridge: Bridge; onBack: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const names = new Map(m.nodes.map((n) => [n.id, n.hostname]));
  const rows: [string, string][] = [
    ['address', node.ip],
    ['status', node.status === 'entry' ? 'foothold' : node.status === 'breached' ? 'owned' : node.reachable ? 'locked · breachable from here' : 'locked'],
  ];
  if (node.status === 'locked') {
    rows.push(['lock', `security ${node.security} · ${node.lockFamily ?? '—'}`]);
    rows.push(['breach cost', `+${node.breachCost} trace${m.watchdogNodeId === node.id ? ' (watchdog ×2)' : ''}`]);
  }
  if (node.route) rows.push(['road', node.route === 'long' ? 'long road — more, softer locks' : 'hot road — one hard lock']);
  if (node.vault) rows.push(['vault', 'optional side room — extra loot, extra trace']);
  if (node.objectiveRole) rows.push(['objective', node.objectiveRole === 'drop' ? 'drop point for the payload' : node.objectiveRole === 'dossier' ? 'holds the dossier' : 'holds flagged files']);
  if (node.lootValue) rows.push(['loot', `~$${node.lootValue}`]);
  if (node.logsLeft) rows.push(['logs', `${node.logsLeft} · rm each for −8 trace`]);
  if (node.clueAt.length && node.status === 'locked') rows.push(['cipher clue', `on ${node.clueAt.join(', ')}`]);
  rows.push(['links', node.neighbors.map((id) => names.get(id) ?? id).join(', ')]);

  const action = node.reachable ? `breach ${node.ip}` : node.status !== 'locked' && !node.isCurrent ? `connect ${node.ip}` : null;
  return (
    <div className="node-detail" ref={ref} aria-live="polite">
      <h3>{node.hostname}</h3>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="detail-actions">
        {action && (
          <button type="button" className="act" onClick={() => bridge.composeInput(action)} title="puts the command on your command line — Enter runs it">
            type `{action}`
          </button>
        )}
        <button type="button" className="act ghosty" onClick={onBack}>
          back to command line
        </button>
      </div>
    </div>
  );
}

/* ================================= intel ================================= */

export function IntelPanel({
  bridge,
  snap,
  open,
  onClose,
  backToCommand,
}: {
  bridge: Bridge;
  snap: Snapshot;
  open: boolean;
  onClose: () => void;
  backToCommand: () => void;
}) {
  const m = snap.mode === 'mission' ? snap.mission : null;
  return (
    <aside
      id="intel-panel"
      className={`side drawer drawer-right ${open ? 'open' : ''}`}
      aria-label="mission intel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onClose();
          backToCommand();
        }
      }}
    >
      <div className="drawer-head panel-title">
        <span>INTEL</span>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="close intel">
          ✕
        </button>
      </div>
      {m ? <ObjectivePanel m={m} /> : <OperatorPanel snap={snap} />}
      {m && <ToolsPanel m={m} />}
      <HandlerPanel bridge={bridge} />
    </aside>
  );
}

function ObjectivePanel({ m }: { m: Mission }) {
  const o = m.objective;
  return (
    <section className="panel" aria-label="objective">
      <div className="panel-title">OBJECTIVE{m.practice ? ' · PRACTICE' : ''}</div>
      <div className="objectives">
        <div className={`obj main ${o.done ? 'done' : ''}`}>
          <span className="tick">{o.done ? '■' : '□'}</span>
          <span>
            {o.label}
            <span className="where"> · {o.progress}</span>
          </span>
        </div>
        {o.type === 'flagged' &&
          m.targets
            .filter((t) => !!t.id)
            .map((t) => (
              <div key={t.id} className={`obj sub ${t.stolen ? 'done' : ''}`}>
                <span className="tick">{t.stolen ? '✓' : '·'}</span>
                <span>
                  {t.name} <span className="where">· {m.nodes.find((n) => n.id === t.nodeId)?.hostname ?? t.nodeId}</span>
                </span>
              </div>
            ))}
        {o.payload && (
          <div className="obj sub">
            <span className="tick">⇡</span>
            <span>
              upload {o.payload.name} <span className="where">→ {o.payload.host}:{o.payload.dir}</span>
            </span>
          </div>
        )}
        {m.optionalLoot > 0 && (
          <div className="obj sub optional">
            <span className="tick">$</span>
            <span>optional loot ~${m.optionalLoot} — greed has a meter</span>
          </div>
        )}
        {m.modifier && (
          <div className="obj sub modifier">
            <span className="tick">!</span>
            <span>
              {m.modifier.name}: {m.modifier.effect} · +${m.modifier.bonus}
            </span>
          </div>
        )}
        <div className="obj sub">
          <span className="tick">▸</span>
          <span>
            carried ${m.sessionCash} · {m.sessionXp} xp
          </span>
        </div>
      </div>
    </section>
  );
}

function ToolsPanel({ m }: { m: Mission }) {
  return (
    <section className="panel" aria-label="tools">
      <div className="panel-title">TOOLS · {m.loadoutLabel}</div>
      <div className="tools">
        <div className={`tool ${m.tools.proxy === 0 ? 'spent' : ''}`}>
          <span>proxy</span>
          <span className="cnt">×{m.tools.proxy} · −25 trace</span>
        </div>
        <div className={`tool ${m.tools.decoy === 0 ? 'spent' : ''}`}>
          <span>decoy</span>
          <span className="cnt">
            ×{m.tools.decoy} · {m.decoyActive ? 'watchdog distracted' : m.watchdogNodeId ? 'diverts the watchdog' : 'no watchdog yet'}
          </span>
        </div>
        <div className={`tool ${m.logsLeft === 0 ? 'spent' : ''}`}>
          <span>logs</span>
          <span className="cnt">×{m.logsLeft} on network · rm = −8</span>
        </div>
      </div>
    </section>
  );
}

function OperatorPanel({ snap }: { snap: Snapshot }) {
  const p = snap.profile;
  const next = p.nextRank;
  const pct = next ? Math.min(100, Math.round((p.xp / next.xp) * 100)) : 100;
  return (
    <section className="panel" aria-label="operator">
      <div className="panel-title">OPERATOR</div>
      <div className="objectives">
        <div className="obj">
          <span className="tick">◆</span>
          <span>
            {p.rank} · {p.xp} xp{next ? ` / ${next.xp} → ${next.name}` : ' · max rank'}
          </span>
        </div>
        <div className="xpbar" aria-hidden="true">
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="obj">
          <span className="tick">▣</span>
          <span>
            board {p.contractsDone}/10{p.campaignComplete ? ' · complete ★' : ''}
          </span>
        </div>
        <div className="obj">
          <span className="tick">⚙</span>
          <span>module: {p.equipped ?? 'none'} · `loadout`</span>
        </div>
        {snap.pending && (
          <div className="obj warn">
            <span className="tick">!</span>
            <span>parked: {snap.pending.label} · `resume`</span>
          </div>
        )}
      </div>
    </section>
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
            // guidance is transient — a new "Next:" replaces the old, and a
            // finished run clears the run's chatter, so the panel never
            // contradicts the game
            const transient = (x: string) => /^(Next|Focus|Lock re-armed|Picking up)/.test(x);
            let out = prev;
            for (const msg of incoming) {
              if (msg === GUIDANCE_RESET) out = [];
              else out = [...(transient(msg) ? out.filter((x) => !transient(x)) : out), msg];
            }
            return out.slice(-6);
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
    <section className="panel handler-panel" aria-label="the broker">
      <div className="panel-title">THE BROKER</div>
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

/* ================================= dock ================================== */

/** Docked above the command line at every width: the lock, the transfer, the result. */
export function Dock({ bridge, snap }: { bridge: Bridge; snap: Snapshot }) {
  const m = snap.mode === 'mission' ? snap.mission : null;
  return (
    <div className="dock">
      {m && <StatusStrip m={m} />}
      {m?.puzzle && <LockPanel m={m} bridge={bridge} />}
      {m?.transfer && <TransferPanel m={m} />}
      {snap.mode === 'post' && snap.lastResult && <ResultStrip snap={snap} />}
    </div>
  );
}

function StatusStrip({ m }: { m: Mission }) {
  return (
    <div className="status-strip" aria-label="objective and tools">
      <span className={m.objective.done ? 'ok' : ''}>
        ⚑ {m.objective.progress}
        {m.objective.done ? ' — disconnect' : ''}
      </span>
      <span>
        proxy ×{m.tools.proxy} · decoy ×{m.tools.decoy}
      </span>
      {m.watchdogNodeId && <span className="bad">watchdog @ {m.nodes.find((n) => n.id === m.watchdogNodeId)?.hostname}</span>}
    </div>
  );
}

function LockPanel({ m, bridge }: { m: Mission; bridge: Bridge }) {
  const p = m.puzzle!;
  const frac = p.timeLimit > 0 ? p.timeLeft / p.timeLimit : 0;
  const urgent = frac <= 0.25;
  const compose = (cmd: string) => bridge.composeInput(cmd);
  const knockDots = Array.from({ length: p.knockLength }, (_, i) => (i < p.knockEntered ? '●' : '○')).join(' ');
  const wheel = p.cipherWheel?.split('\n') ?? null;
  return (
    <section className={`lock-panel ${urgent ? 'urgent' : ''}`} aria-label="open lock" data-testid="lock-panel">
      <div className="lock-head">
        <span className="lock-title">
          LOCK · {p.familyLabel} · {p.hostname}
        </span>
        <span className="lock-attempts">tries {p.attempts}</span>
      </div>
      <div className="fuse" role="timer" aria-label={`fuse ${Math.ceil(p.timeLeft)} seconds`}>
        <div className="fuse-fill" style={{ width: `${Math.max(0, frac * 100)}%` }} />
        <span className="fuse-text">{Math.ceil(p.timeLeft)}s</span>
      </div>
      <div className="lock-body">
        {p.family === 'sequence' && (
          <>
            <div className="lock-prompt seq" data-testid="lock-prompt" aria-label={`sequence ${p.sequenceTerms.join(', ')}, then unknown`}>
              {p.sequenceTerms.map((t, i) => (
                <span key={i} className="term">
                  {t}
                </span>
              ))}
              <span className="term unknown">??</span>
            </div>
            <div className="lock-help">one rule: constant step · constant ratio · sum of last two · perfect squares</div>
          </>
        )}
        {p.family === 'portknock' && (
          <>
            {p.knockPortsVisible ? (
              <div className="knock-ports glow" data-testid="knock-ports">
                {p.knockPorts.map((port, i) => (
                  <span key={i} className={`port ${i < p.knockEntered ? 'held' : ''}`}>
                    {port}
                  </span>
                ))}
              </div>
            ) : (
              <div className="knock-memory">
                <span className="memory-label">MEMORY CHALLENGE</span> ports dark · {knockDots} ({p.knockEntered}/{p.knockLength})
              </div>
            )}
            <div className="lock-help">{p.knockPortsVisible ? 'memorize the glow — then knock in order' : 'knock from memory, all at once or one port at a time'}</div>
          </>
        )}
        {p.family === 'cipher' && (
          <>
            <div className="lock-prompt" data-testid="lock-prompt">
              {p.cipherText}
            </div>
            {wheel ? (
              <div className="wheel" aria-label="decoding strip: plaque letter above, plain letter below">
                <div>
                  <span className="wheel-k">plaque</span> {wheel[0]}
                </div>
                <div>
                  <span className="wheel-k">plain </span> {wheel[1]}
                </div>
              </div>
            ) : (
              <div className="lock-help">
                {p.clueHint ? (
                  <>
                    wheel tag: <code>{p.clueHint}</code> — <code>cat</code> works mid-lock
                  </>
                ) : (
                  <>no wheel tag known — `hint` buys the offset</>
                )}
              </div>
            )}
          </>
        )}
        <div className="lock-usage">
          answer: <code>{p.answerUsage}</code>
        </div>
      </div>
      <div className="lock-actions" aria-label="escape hatches (fills the command line)">
        <button type="button" className="act" onClick={() => compose('hint')}>
          hint ${p.hintCost}
        </button>
        <button type="button" className="act" onClick={() => compose('skip')}>
          skip +25
        </button>
        <button type="button" className="act" disabled={m.tools.proxy === 0} onClick={() => compose('proxy')}>
          proxy ×{m.tools.proxy}
        </button>
        <button type="button" className="act" disabled={m.tools.decoy === 0 || !m.watchdogNodeId} onClick={() => compose('decoy')}>
          decoy ×{m.tools.decoy}
        </button>
        <button type="button" className="act ghosty" onClick={() => compose('disconnect')}>
          disconnect
        </button>
      </div>
    </section>
  );
}

function TransferPanel({ m }: { m: Mission }) {
  const t = m.transfer!;
  return (
    <section className={`transfer-panel ${t.watched ? 'watched' : ''}`} aria-label="transfer" data-testid="transfer-panel">
      <span className="xfer-op">{t.op === 'upload' ? '⇡ UPLOAD' : '⇣ DOWNLOAD'}</span>
      <span className="xfer-file">{t.file}</span>
      <div className="xfer-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={t.pct} aria-label={`${t.op} ${t.file}`}>
        <div style={{ width: `${t.pct}%` }} />
      </div>
      <span className="xfer-meta">
        {t.pct}% · {t.secondsLeft.toFixed(1)}s · {fmtRate(t.traceRate)} trace{t.watched ? ' · WATCHDOG ×2' : ''}
      </span>
    </section>
  );
}

function ResultStrip({ snap }: { snap: Snapshot }) {
  const r = snap.lastResult!;
  return (
    <section className={`result-strip ${r.outcome}`} aria-label="result" data-testid="result">
      <div className="result-main">
        <strong>{OUTCOME_LABEL[r.outcome]}</strong> · {r.objectiveLabel} {r.filesStolen}/{r.filesRequired} · ${r.cash} · {r.trace}% trace
        {r.practice ? ' · practice' : ''}
      </div>
      <div className="result-hint">
        <kbd>Enter</kbd> retry same job · <code>contracts</code> board · <code>share</code> code · <code>records</code>
      </div>
    </section>
  );
}
