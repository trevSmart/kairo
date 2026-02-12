import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  webServer: {
    command: 'npm start',
    url: 'http://localhost:3456',
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:3456',
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
});
