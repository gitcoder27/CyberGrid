import { expect, type Locator, type Page } from '@playwright/test';

/**
 * A scripted "human" for browser journeys. It only uses what a player has:
 * the keyboard, the visible lock/transfer panels, the suggestion that TAB
 * fills, and the terminal text (via the screen-reader transcript). It solves
 * locks by reading them — sequence rules, glowing knock ports, the cipher
 * wheel — never by peeking at engine state.
 */
export class Player {
  readonly input: Locator;
  readonly transcript: Locator;
  readonly lock: Locator;
  readonly transfer: Locator;
  readonly result: Locator;

  constructor(readonly page: Page) {
    this.input = page.getByTestId('command-input');
    this.transcript = page.getByTestId('transcript');
    this.lock = page.getByTestId('lock-panel');
    this.transfer = page.getByTestId('transfer-panel');
    this.result = page.getByTestId('result');
  }

  async open(): Promise<void> {
    await this.page.goto('/');
    await expect(this.input).toBeFocused();
    // any key skips the boot sequence
    await this.page.keyboard.press('Space');
    await expect(this.transcript).toContainText('type `help` for verbs');
    await this.input.fill('');
  }

  async lines(n = 40): Promise<string[]> {
    return (await this.transcript.locator('p').allTextContents()).slice(-n);
  }

  async text(n = 40): Promise<string> {
    return (await this.lines(n)).join('\n');
  }

  /** Type a command with the keyboard and press Enter. */
  async run(cmd: string): Promise<void> {
    await this.input.click();
    await this.input.fill('');
    await this.page.keyboard.type(cmd, { delay: 5 });
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(120);
  }

  /** TAB-fill the glowing suggestion; returns what was filled ('' if nothing). */
  async tabFill(): Promise<string> {
    await this.input.fill('');
    await this.page.keyboard.press('Tab');
    return this.input.inputValue();
  }

  async waitIdle(): Promise<void> {
    // scan/breach spin-ups and transfers take a moment
    await this.page.waitForTimeout(250);
    await expect(this.transfer).toHaveCount(0, { timeout: 15_000 });
  }

  /** What the screen is showing. A bust sequence counts as over: the player waits it out. */
  async mode(): Promise<'mission' | 'post' | 'home' | 'boot'> {
    const app = this.page.locator('.app');
    await expect(app).not.toHaveClass(/\bcutscene\b/, { timeout: 20_000 });
    const cls = (await app.getAttribute('class')) ?? '';
    return (/mode-(mission|post|home|boot)/.exec(cls)?.[1] ?? 'home') as 'mission' | 'post' | 'home' | 'boot';
  }

  /** Solve whatever lock is open by reading the lock panel. */
  async solveLock(): Promise<void> {
    await expect(this.lock).toBeVisible();
    const title = (await this.lock.locator('.lock-title').textContent()) ?? '';
    if (/knock/i.test(title)) {
      const ports = this.lock.getByTestId('knock-ports');
      let seq: string[];
      if (await ports.count()) seq = (await ports.locator('.port').allTextContents()).map((s) => s.trim());
      else {
        // ports already dark: scroll back to where the terminal printed the glow
        const glow = (await this.lines(120)).reverse().find((l) => l.includes('Knock sequence glowing:'));
        if (!glow) throw new Error('knock sequence never seen');
        seq = glow.split('glowing:')[1]!.split('·').map((s) => s.trim());
      }
      await this.run(`knock ${seq.join(' ')}`);
      return;
    }
    if (/cipher/i.test(title)) {
      if (!(await this.lock.locator('.wheel').count())) {
        const help = (await this.lock.locator('.lock-help').textContent()) ?? '';
        const m = /wheel tag: (\S+) on this node/.exec(help);
        if (m) await this.run(`cat ${m[1]}`);
        else await this.run('hint');
      }
      await expect(this.lock.locator('.wheel')).toBeVisible();
      const rows = await this.lock.locator('.wheel > div').allTextContents();
      const plaque = rows[0]!.replace(/^\s*plaque\s*/, '').trim();
      const plain = rows[1]!.replace(/^\s*plain\s*/, '').trim();
      const cipher = ((await this.lock.getByTestId('lock-prompt').textContent()) ?? '').trim();
      const word = [...cipher.toUpperCase()].map((ch) => plain[plaque.indexOf(ch)] ?? ch).join('');
      await this.run(`input ${word}`);
      return;
    }
    const terms = await this.lock.locator('.term:not(.unknown)').allTextContents();
    await this.run(`input ${nextTerm(terms.map((t) => `[${t.trim()}]`).join(' '))}`);
  }

  /**
   * Play the current mission to the end like a newcomer who trusts the
   * suggestions and solves every lock. At a fork it takes the requested road
   * (long = softest lock listed, hot = hardest); with `vault` it detours into
   * the vault before leaving.
   */
  async playMission(opts: { maxSteps?: number; road?: 'long' | 'hot'; vault?: boolean } = {}): Promise<void> {
    let vaultDone = !opts.vault;
    for (let step = 0; step < (opts.maxSteps ?? 60); step++) {
      await this.waitIdle();
      if ((await this.mode()) !== 'mission') return;
      if (await this.lock.count()) {
        await this.solveLock();
        continue;
      }
      let filled = await this.tabFill();
      if (!filled) {
        // a scan or breach may still be spinning up (no suggestion meanwhile)
        await this.page.waitForTimeout(700);
        if ((await this.mode()) !== 'mission' || (await this.lock.count())) continue;
        filled = await this.tabFill();
      }
      if (filled === 'disconnect' && !vaultDone) {
        vaultDone = true;
        await this.input.fill('');
        await this.raidVault();
        continue;
      }
      if (filled) {
        await this.page.keyboard.press('Enter');
        continue;
      }
      // Still nothing: a fork. Ask the terminal what is reachable and pick a road.
      await this.run('breach');
      const options = (await this.lines(8))
        .map((l) => /^\s+breach (\d+\.\d+\.\d+\.\d+)\s+\(([^)]*)\)/.exec(l))
        .filter((m): m is RegExpExecArray => !!m && !/VAULT/.test(m[2]!))
        .map((m) => ({ ip: m[1]!, sec: Number(/sec (\d)/.exec(m[2]!)?.[1] ?? 0) }));
      // otherwise the terminal has set a suggestion (e.g. `connect` back to a border node)
      if (!options.length) continue;
      options.sort((a, b) => (opts.road === 'hot' ? b.sec - a.sec : a.sec - b.sec));
      await this.run(`breach ${options[0]!.ip}`);
    }
    throw new Error('mission did not end');
  }

  /** Detour into the vault: find it on the map, get next to it, crack it, take the loot. */
  async raidVault(): Promise<void> {
    const vault = this.page.locator('.graph .node.vault, .node.vault').first();
    if (!(await vault.count())) return;
    await vault.focus();
    await this.page.keyboard.press('Enter');
    const detail = this.page.locator('.node-detail');
    if (!(await vault.getAttribute('class'))?.includes('reachable')) {
      const links = (await detail.locator('div', { has: this.page.locator('dt', { hasText: /^links$/ }) }).locator('dd').textContent()) ?? '';
      const owned = await this.page.locator('.node.breached .hostname, .node.entry .hostname').allTextContents();
      const via = links.split(',').map((x) => x.trim()).find((h) => owned.includes(h));
      if (!via) return;
      await this.run(`connect ${via}`);
      await this.waitIdle();
    }
    await this.backToInput();
    const ip = (await detail.locator('dd').first().textContent())!.trim();
    await this.run(`breach ${ip}`);
    await this.waitIdle();
    while (await this.lock.count()) {
      await this.solveLock();
      await this.waitIdle();
    }
    const line = (await this.lines(20)).reverse().find((l) => l.includes('— VAULT:'));
    if (!line) return;
    const paths = line.split('— VAULT:')[1]!.replace(/\+\d+ more/, '').split('·').map((x) => x.trim()).filter(Boolean);
    for (const path of paths) {
      await this.run(`download ${path}`);
      await this.waitIdle();
      if ((await this.mode()) !== 'mission') return;
    }
  }

  async backToInput(): Promise<void> {
    await this.input.focus();
  }
}

/** The four documented sequence rules — one rule must fit every term shown. */
export function nextTerm(prompt: string): number {
  const t = [...prompt.matchAll(/\[(-?\d+)\]/g)].map((m) => Number(m[1]));
  const n = t.length;
  const all = (ok: (i: number) => boolean) => t.every((_, i) => i < 2 || ok(i));
  if (all((i) => t[i]! - t[i - 1]! === t[i - 1]! - t[i - 2]!)) return t[n - 1]! * 2 - t[n - 2]!;
  if (t[0] !== 0 && all((i) => t[i]! * t[i - 2]! === t[i - 1]! * t[i - 1]!)) return (t[n - 1]! * t[n - 1]!) / t[n - 2]!;
  if (all((i) => t[i]! === t[i - 1]! + t[i - 2]!)) return t[n - 1]! + t[n - 2]!;
  const r = Math.round(Math.sqrt(t[n - 1]!));
  if (r * r === t[n - 1]) return (r + 1) * (r + 1);
  throw new Error(`no rule fits ${t.join(' ')}`);
}

/** Seed localStorage before the app loads (a returning player's save). */
export async function seedSave(page: Page, key: string, blob: unknown): Promise<void> {
  await page.addInitScript(
    ([k, v]) => {
      if (!window.sessionStorage.getItem('seeded')) {
        window.localStorage.setItem(k, v);
        window.sessionStorage.setItem('seeded', '1');
      }
    },
    [key, JSON.stringify(blob)] as const
  );
}

export function profileSave(profile: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return { version: 2, profile: { tutorialDone: true, ...profile }, settings: { typing: false }, history: [], session: null, ...extra };
}
