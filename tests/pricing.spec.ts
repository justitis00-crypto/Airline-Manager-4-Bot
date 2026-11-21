import { test } from '@playwright/test';
import { GeneralUtils } from '../utils/general.utils';
import { PricingUtils } from '../utils/pricing.utils';

require('dotenv').config();

// Sets ticket prices to the best known level for every passenger route.
// Starts in "inspect" mode (read-only). See the README, "Automatic pricing".
test('Pricing', async ({ page }) => {
  test.setTimeout(40 * 60 * 1000);

  const generalUtils = new GeneralUtils(page);
  const pricingUtils = new PricingUtils(page, PricingUtils.optionsFromEnv());

  await generalUtils.login(page);
  await pricingUtils.run();

  page.close();
});
