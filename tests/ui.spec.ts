import { test, expect } from '@playwright/test';

test('homepage loads without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/');
  await expect(page.locator('h1')).toContainText('Kairo');
  expect(errors, 'no console errors').toHaveLength(0);
});

test('graph view loads for project from config', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!text.includes('404') && !text.includes('Failed to load resource')) errors.push(text);
    }
  });

  await page.goto('/graph.html?project=kairo');
  await page.waitForTimeout(5000);

  const graph = page.locator('#graph');
  const shellCard = page.locator('.card');
  await expect(graph.or(shellCard)).toBeVisible();
  expect(errors, 'no critical console errors').toHaveLength(0);
});

test('list view loads for project from config', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!text.includes('404') && !text.includes('Failed to load resource')) errors.push(text);
    }
  });

  await page.goto('/list.html?project=kairo');
  await page.waitForTimeout(6000);

  await expect(page.locator('#container')).toBeVisible();
  expect(errors, 'no critical console errors').toHaveLength(0);
});
