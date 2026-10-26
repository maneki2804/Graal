import { defineConfig, devices } from '@playwright/test';

// Fixed loopback target; never reuse a developer or production server.
const port = 8877;
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node server.js',
    env: { PORT: String(port) },
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 15000,
  },
});
