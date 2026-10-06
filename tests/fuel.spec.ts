import { test } from '@playwright/test';
import { GeneralUtils } from '../utils/general.utils';
import { FuelUtils } from '../utils/fuel.utils';

require('dotenv').config();

test('Fuel Operations', async ({ page }) => {
  test.setTimeout(60000);

  const fuelUtils = new FuelUtils(page);
  const generalUtils = new GeneralUtils(page);

  await generalUtils.login(page);

  // Open the Fuel window only. This workflow must never dispatch planes.
  await page.locator('#mapMaint > img').first().click();
  await GeneralUtils.sleep(1000);

  await fuelUtils.buyFuel();
});
