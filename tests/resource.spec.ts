import { test } from '@playwright/test';
import { GeneralUtils } from '../utils/general.utils';
import { FuelUtils } from '../utils/fuel.utils';

require('dotenv').config();

test('Resource Operations', async ({ page }) => {
  test.setTimeout(60000);

  const fuelUtils = new FuelUtils(page);
  const generalUtils = new GeneralUtils(page);

  await generalUtils.login(page);

  // Open the Fuel/CO2 window.
  await page.locator('#mapMaint > img').first().click();
  await GeneralUtils.sleep(1000);

  const checkType = process.env.CHECK_TYPE;

  if (checkType === 'fuel') {
    console.log('Running scheduled Fuel check...');
    await fuelUtils.buyFuel();
  } else if (checkType === 'co2') {
    console.log('Running scheduled CO2 check...');
    await page.getByRole('button', { name: ' Co2' }).click();
    await GeneralUtils.sleep(1000);
    await fuelUtils.buyCo2();
  } else {
    throw new Error('CHECK_TYPE must be either "fuel" or "co2".');
  }
});
