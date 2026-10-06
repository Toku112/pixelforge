import { expect, test } from '@playwright/test';
import { APP_NAME } from '../../src/app/brand';

test('app loads with the product name and no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await expect(page).toHaveTitle(APP_NAME);
  await expect(page.getByTestId('app-root')).toBeVisible();
  expect(errors).toEqual([]);
});
