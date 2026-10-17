import { defineConfig } from '@playwright/test';

const baseURL = `http://127.0.0.1:${process.env.DOCS_TEST_PORT ?? '43219'}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    launchOptions: { executablePath: process.env.CHROME_PATH },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/static-server.mjs',
    url: `${baseURL}/fundamentals/redis-overview/`,
    reuseExistingServer: !process.env.CI,
  },
});
