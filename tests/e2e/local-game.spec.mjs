import { test, expect } from '@playwright/test';

function recordErrors(page, errors) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
}

// The shipped client has a fixed Railway URL. Redirect only inside the test
// browser, before application scripts run. Real WS messages reach our server.
test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' && url.pathname === '/favicon.ico') {
      return route.fulfill({ status: 204 });
    }
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class LocalWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        const requested = new URL(url, location.href);
        if (!['ws:', 'wss:'].includes(requested.protocol))
          throw new Error('Unexpected WS protocol');
        super(`ws://${location.host}`, protocols);
      }
    };
  });
});

test('serves health and the title screen without JavaScript errors', async ({
  page,
  request,
}) => {
  const errors = [];
  recordErrors(page, errors);
  const health = await request.get('/health');
  expect(health.ok()).toBe(true);
  expect(await health.text()).toBe('ok');
  await page.goto('/');
  await expect(page).toHaveTitle(/Graal Hunt/);
  await expect(page.locator('#screen-title')).toBeVisible();
  await expect(page.locator('#btn-create-room')).toBeVisible();
  expect(errors).toEqual([]);
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
  { width: 1440, height: 1080 },
]) {
  test(`opens the class picker repeatedly and starts a local battle at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const errors = [];
    recordErrors(page, errors);
    await page.goto('/');
    for (let i = 0; i < 2; i++) {
      await page.locator('#btn-battle-test').click();
      await expect(page.locator('#screen-classpick')).toBeVisible();
      await expect(page.locator('.classpick-slot')).toHaveCount(4);
      await page
        .locator('#classpick-slots [data-slot="0"][data-class="mage"]')
        .click();
      await expect(page.locator('#btc-preview-0')).toContainText('HP:7 ATK:4');
      if (i === 0) await page.locator('#btn-back-classpick').click();
    }
    await page.locator('#btn-start-battle').click();
    await expect(page.locator('#screen-combat')).toBeVisible();
    await expect(
      page.locator('#combat-field-a .combat-fighter-card'),
    ).toHaveCount(4);
    await expect(
      page.locator('#combat-field-b .combat-fighter-card'),
    ).toHaveCount(4);
    await expect(page.locator('#btn-combat-attack')).toBeEnabled();
    await expect(
      page.getByText('Соединение потеряно. Обновите страницу.', {
        exact: true,
      }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('two local clients join a room, choose classes and reach the map', async ({
  context,
}) => {
  const host = await context.newPage();
  const guest = await context.newPage();
  const errors = [];
  for (const page of [host, guest]) recordErrors(page, errors);
  await host.goto('/');
  await host.locator('#teams-select [data-val="2"]').click();
  await host.locator('#btn-create-room').click();
  await expect(host.locator('#screen-lobby')).toBeVisible();
  await expect(host.locator('#lobby-code')).toHaveText(/^[A-Z2-9]{5}$/);
  const code = await host.locator('#lobby-code').textContent();
  await guest.goto('/');
  await guest.locator('#btn-join-room').click();
  await guest.locator('#join-code-input').fill(code);
  await guest.locator('#btn-do-join').click();
  await expect(host.locator('#btn-confirm-ability')).toBeVisible();
  await host.locator('#btn-confirm-ability').click();
  await expect(guest.locator('#btn-confirm-ability')).toBeVisible();
  await guest.locator('#btn-confirm-ability').click();
  await expect(host.locator('#screen-game')).toBeVisible();
  await expect(guest.locator('#screen-game')).toBeVisible();
  expect(errors).toEqual([]);
});
