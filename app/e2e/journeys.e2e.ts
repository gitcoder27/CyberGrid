import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { Player, seedSave, profileSave } from './player.js';

const SAVE_KEY = 'cybergrid.save.v2';
const LEGACY_KEY = 'cybergrid.save.v1';
const legacy = JSON.parse(
  readFileSync(new URL('../../packages/engine/test/fixtures/legacy-v1-saves.json', import.meta.url), 'utf8')
) as Record<string, any>;

test.describe('first session', () => {
  test('tutorial → contract 1 → Enter on results never blocks → contracts → contract 2', async ({ page }) => {
    const me = new Player(page);
    await me.open();
    await expect(me.transcript).toContainText('tutorial');

    // The tutorial is played entirely with TAB + Enter on the glowing suggestion.
    await me.run('tutorial');
    await me.playMission();
    await expect(me.transcript).toContainText('tutorial complete');
    // the Broker panel drops the tutorial's step chatter and signs off
    await expect(page.locator('.handler-panel')).toContainText("That's the whole trade");
    await expect(page.locator('.handler-panel')).not.toContainText('press TAB');

    // F01: Enter on the results screen is never swallowed — it means "retry";
    // a typed command still runs.
    await me.run('contracts');
    await expect(me.transcript).toContainText('THE BOARD');
    await me.run('run 1');
    await expect(page.locator('.prompt')).not.toContainText('homegrid');
    await me.playMission();
    await expect(me.result).toBeVisible();
    await expect(me.result).toContainText(/CLEAN|HOT|EARLY/);

    await me.run('contracts');
    await expect(me.transcript).toContainText('THE BOARD');
    await me.run('run 2');
    await expect(me.transcript).toContainText('CONTRACT #2');
  });

  test('empty Enter on the results screen retries the same job', async ({ page }) => {
    await seedSave(page, SAVE_KEY, profileSave({ contractsDone: 1, cash: 200, xp: 400 }));
    const me = new Player(page);
    await me.open();
    await me.run('run 1');
    await expect(me.transcript).toContainText('CONTRACT #1');
    await me.run('disconnect');
    await expect(me.result).toBeVisible();
    await expect(me.result).toContainText('EARLY');
    // a bare Enter in the first beat is ignored (keys still flying from the run)…
    await me.input.fill('');
    await page.keyboard.press('Enter');
    await expect(me.result).toBeVisible();
    // …then it means "retry"
    await page.waitForTimeout(900);
    await me.input.fill('');
    await page.keyboard.press('Enter');
    await expect(me.result).toHaveCount(0);
    await expect(me.transcript).toContainText(/CONTRACT #1/);
    await expect(page.locator('.prompt')).not.toContainText('homegrid');
  });
});

test.describe('saves', () => {
  test('a run with an open lock survives two reloads and a settings change', async ({ page }) => {
    await seedSave(page, SAVE_KEY, profileSave({ contractsDone: 3, cash: 600, xp: 1500 }));
    const me = new Player(page);
    await me.open();
    await me.run('run 4');
    // play until the first lock opens, then walk away
    for (let i = 0; i < 20 && !(await me.lock.count()); i++) {
      await me.waitIdle();
      const filled = await me.tabFill();
      if (filled) await page.keyboard.press('Enter');
      else await me.run('breach');
      await page.waitForTimeout(300);
    }
    await expect(me.lock).toBeVisible();
    const lockTitle = await me.lock.locator('.lock-title').textContent();
    await me.run('settings typing off');
    await page.waitForTimeout(400);

    for (let reload = 0; reload < 2; reload++) {
      await page.reload();
      await page.keyboard.press('Space');
      await expect(me.transcript).toContainText('parked run');
      await me.run('resume');
      await expect(me.transcript).toContainText('session restored');
      await expect(me.lock).toBeVisible();
      await expect(me.lock.locator('.lock-title')).toHaveText(lockTitle!);
    }
    const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!), SAVE_KEY);
    expect(saved.settings.typing).toBe(false);

    await me.solveLock();
    await expect(me.lock).toHaveCount(0);
    await me.playMission();
    await expect(me.result).toBeVisible();
  });

  test('a v1 save mid-transfer migrates, resumes the transfer, and keeps the v1 backup', async ({ page }) => {
    await seedSave(page, LEGACY_KEY, legacy.contractTransfer);
    const me = new Player(page);
    await me.open();
    await expect(me.transcript).toContainText('parked run');
    await me.run('resume');
    await expect(me.transcript).toContainText('resumes at 44%');
    await expect(me.transfer).toContainText('schema_backup.sql');
    await me.waitIdle();
    await me.run('disconnect');
    await expect(me.result).toBeVisible();

    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys).toContain(LEGACY_KEY);
    expect(keys).toContain(SAVE_KEY);
    const v2 = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!), SAVE_KEY);
    expect(v2.version).toBe(2);
    expect(v2.profile.upgrades.overclock).toBe(1);
  });
});

test.describe('locks', () => {
  test('the cipher clue is readable with `cat` mid-lock, and proxy works mid-lock', async ({ page }) => {
    await seedSave(page, LEGACY_KEY, legacy.cipherLock.blob);
    const me = new Player(page);
    await me.open();
    await me.run('resume');
    await expect(me.lock).toBeVisible();
    await expect(me.lock.locator('.lock-title')).toContainText('cipher');
    await expect(me.lock.locator('.lock-help')).toContainText('this node');
    const traceBefore = await page.getByTestId('trace').textContent();

    // F08: panic tools stay usable while a lock is open
    await me.run('proxy');
    await expect(me.transcript).toContainText(/proxy/i);
    await expect(me.lock).toBeVisible();
    expect(await page.getByTestId('trace').textContent()).not.toBe(traceBefore);

    // F04: the clue file can be read without leaving the lock; the wheel appears
    await me.solveLock();
    await expect(me.lock).toHaveCount(0);
    await expect(me.transcript).toContainText(/ACCESS GRANTED|unlocked|breached/i);
  });

  test('HUD buttons fill the command line but never execute', async ({ page }) => {
    await seedSave(page, LEGACY_KEY, legacy.cipherLock.blob);
    const me = new Player(page);
    await me.open();
    await me.run('resume');
    await expect(me.lock).toBeVisible();
    await me.lock.getByRole('button', { name: /^skip/ }).click();
    await expect(me.input).toHaveValue('skip');
    await expect(me.input).toBeFocused();
    await expect(me.lock).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(me.input).toHaveValue('');
  });
});

test.describe('daily challenge', () => {
  test('first run is recorded, the second is practice; tomorrow is a new job', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-20T10:00:00Z') });
    await seedSave(page, SAVE_KEY, profileSave({ contractsDone: 4, cash: 900, xp: 2000 }));
    const me = new Player(page);
    await me.open();
    await me.run('daily');
    await expect(me.transcript).toContainText('DAILY · 2026-10-20 UTC');
    await expect(me.transcript).toContainText('recorded attempt');
    const code = /code: (CG1-\S+)/.exec(await me.text(12))![1];

    await me.run('daily start');
    await me.run('disconnect');
    await expect(me.result).toBeVisible();
    await expect(me.result).not.toContainText('practice');

    await me.run('daily');
    await expect(me.transcript).toContainText('runs practice');
    await me.run('daily start');
    await me.run('disconnect');
    await expect(me.result).toContainText('practice');

    await me.run('home');
    await page.clock.setSystemTime(new Date('2026-10-21T00:00:05Z'));
    await me.run('daily');
    await expect(me.transcript).toContainText('DAILY · 2026-10-21 UTC');
    expect(/code: (CG1-\S+)/.exec(await me.text(12))![1]).not.toBe(code);
  });
});

test.describe('layout and accessibility', () => {
  for (const vp of [
    { width: 390, height: 844 },
    { width: 640, height: 400 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    test(`no horizontal overflow and a reachable command line at ${vp.width}px`, async ({ page }) => {
      await page.setViewportSize(vp);
      await seedSave(page, LEGACY_KEY, legacy.cipherLock.blob);
      const me = new Player(page);
      await me.open();
      await me.run('resume');
      await expect(me.lock).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await expect(me.input).toBeInViewport();
      await expect(page.getByTestId('trace')).toBeInViewport();
      await expect(me.lock.locator('.fuse')).toBeInViewport();
    });
  }

  test('map drawer by keyboard on a phone: inspect a node, compose, Esc back to input', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedSave(page, SAVE_KEY, profileSave({ contractsDone: 1, cash: 200, xp: 400 }));
    const me = new Player(page);
    await me.open();
    await me.run('run 1');
    await me.run('scan');
    await me.waitIdle();

    const mapBtn = page.locator('.map-btn');
    await mapBtn.focus();
    await page.keyboard.press('Enter');
    const drawer = page.locator('#map-panel');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.drawer-close')).toBeFocused();

    // Tab to the first network node and open its details
    const node = drawer.locator('.node.reachable').first();
    await node.focus();
    await page.keyboard.press('Enter');
    const composeBtn = drawer.getByRole('button', { name: /^type `breach/ });
    await composeBtn.focus();
    await page.keyboard.press('Enter');
    await expect(me.input).toHaveValue(/^breach \d+\.\d+\.\d+\.\d+$/);
    await expect(me.input).toBeFocused();
    await expect(drawer).not.toBeVisible();
    // composed, not executed
    await expect(me.lock).toHaveCount(0);
  });

  test('reduced motion: no shake or glitch classes ever applied', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seedSave(page, SAVE_KEY, profileSave({ contractsDone: 1, cash: 200, xp: 400 }));
    const me = new Player(page);
    await me.open();
    await expect(page.locator('.app')).toHaveClass(/no-motion/);
    await page.evaluate(() => {
      (window as any).__shook = false;
      new MutationObserver(() => {
        if (document.querySelector('.shake, .glitch, .flash-layer')) (window as any).__shook = true;
      }).observe(document.body, { subtree: true, attributes: true, childList: true });
    });
    await me.run('run 1');
    await me.playMission();
    expect(await page.evaluate(() => (window as any).__shook)).toBe(false);
  });

  test('IME composition: Enter while composing does not submit; inserted text does', async ({ page }) => {
    const me = new Player(page);
    await me.open();
    await me.input.focus();
    await page.evaluate(() => {
      const el = document.querySelector('#cmd')!;
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await page.keyboard.insertText('help');
    await page.keyboard.press('Enter');
    await expect(me.input).toHaveValue('help');
    await page.evaluate(() => {
      const el = document.querySelector('#cmd')!;
      el.dispatchEvent(new CompositionEvent('compositionend', { data: 'help', bubbles: true }));
    });
    await page.keyboard.press('Enter');
    await expect(me.input).toHaveValue('');
    await expect(me.transcript).toContainText('contracts');
  });
});

test.describe('command line', () => {
  test('TAB completion, history, paste, and cleared buffers', async ({ page }) => {
    await seedSave(page, SAVE_KEY, profileSave({ contractsDone: 1, cash: 200, xp: 400 }));
    const me = new Player(page);
    await me.open();
    await me.input.focus();
    // TAB completes a unique verb prefix…
    await page.keyboard.type('contr');
    await page.keyboard.press('Tab');
    await expect(me.input).toHaveValue('contracts');
    await page.keyboard.press('Enter');
    await expect(me.transcript).toContainText('THE BOARD');
    // …and lists candidates for an ambiguous one, keeping focus in the field
    await page.keyboard.type('re');
    await page.keyboard.press('Tab');
    await expect(page.locator('.candidates')).toContainText('records');
    await expect(me.input).toBeFocused();
    // Ctrl+C clears the buffer
    await page.keyboard.press('Control+c');
    await expect(me.input).toHaveValue('');
    // ↑ recalls history
    await page.keyboard.press('ArrowUp');
    await expect(me.input).toHaveValue('contracts');
    await page.keyboard.press('ArrowDown');
    await expect(me.input).toHaveValue('');
    // a pasted multi-line command becomes one line
    await page.keyboard.insertText('man\nscan');
    await expect(me.input).toHaveValue('man scan');
    await page.keyboard.press('Enter');
    await expect(me.transcript).toContainText(/scan/i);
    await expect(me.input).toHaveValue('');
    // Shift+Tab leaves the field (keyboard users are never trapped)
    await page.keyboard.press('Shift+Tab');
    await expect(me.input).not.toBeFocused();
  });

  test('mute toggles from the top bar and persists', async ({ page }) => {
    const me = new Player(page);
    await me.open();
    await page.getByRole('button', { name: 'mute sound' }).click();
    await expect(page.getByRole('button', { name: 'unmute sound' })).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.getByRole('button', { name: 'unmute sound' })).toBeVisible();
  });
});

test.describe('pressure', () => {
  test('a fuse that burns out re-arms; skip forces a lock; enough skips bust you and Enter retries', async ({ page }) => {
    test.setTimeout(240_000); // a real 30-second fuse has to burn
    await seedSave(page, SAVE_KEY, profileSave({ contractsDone: 3, cash: 600, xp: 1500 }));
    const me = new Player(page);
    await me.open();
    await me.run('run 4');
    await me.run('scan');
    await expect(me.transcript).toContainText('network mapped');
    await me.run('breach');
    const target = /^\s+breach (\S+)/m.exec(await me.text(6))![1];
    await me.run(`breach ${target}`);
    await expect(me.lock).toBeVisible();
    // let the fuse burn: the dock turns urgent, then the node re-arms and the
    // terminal offers the same breach again
    await expect(me.lock).toHaveClass(/urgent/, { timeout: 40_000 });
    await expect(me.transcript).toContainText('the fuse burned', { timeout: 20_000 });
    await expect(me.lock).toHaveCount(0);
    expect(await me.tabFill()).toBe(`breach ${target}`);
    await page.keyboard.press('Enter');
    await expect(me.lock).toBeVisible();

    await me.run('skip');
    await expect(me.lock).toHaveCount(0);
    await expect(me.transcript).toContainText('ACCESS GRANTED');
    // keep forcing locks until the grid catches us
    for (let i = 0; i < 12 && (await me.mode()) === 'mission'; i++) {
      await me.waitIdle();
      if (await me.lock.count()) {
        await me.run('skip');
        continue;
      }
      await page.waitForTimeout(400);
      await me.run('breach');
      const next = /^\s+breach (\S+)/m.exec(await me.text(6));
      if (next) await me.run(`breach ${next[1]}`);
      else {
        const hop = /`(connect \S+)`/.exec(await me.text(3));
        if (hop) await me.run(hop[1]!);
      }
    }
    await expect(me.result).toBeVisible({ timeout: 20_000 });
    await expect(me.result).toContainText('BUSTED');
    await expect(me.transcript).toContainText('COUNTER-TRACE');
    await page.waitForTimeout(900);
    await me.input.fill('');
    await page.keyboard.press('Enter');
    await expect(me.result).toHaveCount(0);
    await expect(me.transcript).toContainText('CONTRACT #4');
  });
});

test.describe('missions', () => {
  test('dossier on the long road (contract 5), then payload on the hot road with the vault (contract 7)', async ({ page }) => {
    await seedSave(page, SAVE_KEY, profileSave({ contractsDone: 6, cash: 3000, xp: 2000 }));
    const me = new Player(page);
    await me.open();
    await me.run('run 5');
    await expect(page.locator('.objective-panel, [aria-label="objective"]').first()).toContainText(/dossier/i);
    await me.playMission({ road: 'long' });
    await expect(me.result).toContainText(/CLEAN|HOT/);
    await expect(me.result).toContainText('dossier');

    await page.waitForTimeout(900);
    await me.run('run 7');
    await expect(me.transcript).toContainText(/upload/);
    await me.playMission({ road: 'hot', vault: true, maxSteps: 90 });
    await expect(me.result).toBeVisible();
    await expect(me.transcript).toContainText('— VAULT:');
    const out = await me.text(40);
    expect(out).toMatch(/upload complete|payload/i);
  });

  test('equip a module, finish the last contract, see the ending, records, and a resumed daily', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-20T10:00:00Z') });
    await seedSave(page, SAVE_KEY, profileSave({ contractsDone: 9, cash: 5000, xp: 2000 }));
    const me = new Player(page);
    await me.open();
    await me.run('loadout');
    await expect(me.transcript).toContainText('quiet uplink');
    await me.run('equip quiet');
    await expect(me.transcript).toContainText('quiet uplink slotted');

    await me.run('run 10');
    await expect(page.locator('.app')).toContainText('quiet');
    await me.playMission({ maxSteps: 90 });
    await expect(me.result).toBeVisible();
    // the ending plays once on its own; `epilogue` replays it any time
    await expect(me.transcript).toContainText('SECURE CHANNEL');
    await expect(me.transcript).toContainText('CAMPAIGN COMPLETE');
    await expect(page.locator('.handler-panel')).toContainText("That's the last one");
    await me.run('epilogue');
    await expect(me.transcript).toContainText('the wire never is');
    await me.run('records');
    await expect(me.transcript).toContainText(/#10|contract 10/i);

    await me.run('daily start');
    await expect(me.transcript).toContainText('DAILY');
    await me.run('scan');
    await page.reload();
    await page.keyboard.press('Space');
    await expect(me.transcript).toContainText('parked run');
    await me.run('daily');
    await expect(me.transcript).toContainText('recorded attempt in progress');
    await me.run('resume');
    await expect(me.transcript).toContainText('session restored');
    await expect(page.locator('.prompt')).not.toContainText('homegrid');
  });
});
