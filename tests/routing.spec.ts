import { test } from '@playwright/test';
import { GeneralUtils } from '../utils/general.utils';
import { RoutingUtils } from '../utils/routing.utils';

require('dotenv').config();

// Gives parked (new) aircraft an international route with enough economy demand.
// Starts in "inspect" mode (read-only). See the README, "Automatic routing".
test('Routing', async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);
  page.setDefaultTimeout(10000);

  const generalUtils = new GeneralUtils(page);
  const routingUtils = new RoutingUtils(page, RoutingUtils.optionsFromEnv());

  await generalUtils.login(page);
  await GeneralUtils.sleep(3000);
  await routingUtils.run();

  page.close();
});
