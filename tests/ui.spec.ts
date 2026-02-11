import { test, expect } from '@playwright/test';
import path from 'path';

const graphPath = path.resolve(process.cwd(), 'output', 'dependency-graph.html');
const componentPath = path.resolve(process.cwd(), 'output', 'component-list.html');

test('dependency graph slider and heatmap load without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('file://' + graphPath, { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  const initialNodes = await page.evaluate(() => window['nodesDataset']?.length ?? 0);
  await page.locator('#min-weight').press('ArrowRight');
  await page.waitForTimeout(1000);
  const afterNodes = await page.evaluate(() => window['nodesDataset']?.length ?? 0);

  expect(afterNodes).toBeLessThanOrEqual(initialNodes);
  expect(errors, 'no console errors').toHaveLength(0);
});

// Simple smoke test for component list page
test('component list loads without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto('file://' + componentPath, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  expect(errors, 'no console errors').toHaveLength(0);
});
