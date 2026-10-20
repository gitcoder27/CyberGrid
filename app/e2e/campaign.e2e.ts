import { test, expect } from '@playwright/test';
import { Player, seedSave, profileSave } from './player.js';

/**
 * The whole campaign from the keyboard: ten contracts, the ending, the epilogue.
 * Slow (several minutes), so it is opt-in: `CG_CAMPAIGN=1 npm run test:e2e`.
 */
test.skip(!process.env.CG_CAMPAIGN, 'set CG_CAMPAIGN=1 to play the full campaign');
test.setTimeout(20 * 60_000);

test('contracts 1–10 are winnable from the screen and the campaign closes', async ({ page }, info) => {
  await seedSave(page, 'cybergrid.save.v2', profileSave({}));
  const me = new Player(page);
  await me.open();
  const log: string[] = [];
  for (let n = 1; n <= 10; n++) {
    await me.run(`run ${n}`);
    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now();
      await me.playMission({ maxSteps: 120 });
      await expect(me.result).toBeVisible();
      const summary = ((await me.result.locator('.result-main').textContent()) ?? '').trim();
      log.push(`#${n} try ${attempt} · ${((Date.now() - t0) / 1000).toFixed(0)}s · ${summary}`);
      await page.screenshot({ path: info.outputPath(`contract-${n}-try-${attempt}.png`) });
      if (!/BUSTED|EARLY/.test(summary)) break;
      expect(attempt).toBeLessThan(4);
      await page.waitForTimeout(900);
      await me.input.fill('');
      await page.keyboard.press('Enter'); // retry the same job
    }
    if (n === 10) break;
    // spend like a player would: buy the first affordable upgrade on the shop
    await me.run('shop');
  }
  console.log(log.join('\n'));
  await expect(me.transcript).toContainText(/campaign|epilogue/i);
  await me.run('epilogue');
  await page.screenshot({ path: info.outputPath('epilogue.png') });
});
