# Airline-Manager-4-Bot

This repository contains a bot for Airline Manager 4, built with Playwright and scheduled to run on GitHub Actions. The bot is designed to run every hour at 01 and 31 minutes but the schedule can be changed according to preference.
## Features

### Implemented
- Start an eco-friendly campaign if not already started.
- Start a campaign to increase airline reputation.
- Buy fuel and CO2 if prices are below specified thresholds.
- Depart all planes.
- Schedule repairs and A-Checks if needed.
- Buy fuel and CO2 at higher prices if supplies are nearly finished.

## Usage Instructions

1. **Fork this repository.**
2. **Set up secrets:**
   - Go to **Settings** > **Actions** > **Secrets and variables**.
   - Create the following repository secrets:
     - `EMAIL`: \<YOUR-EMAIL>
     - `PASSWORD`: \<YOUR-PASSWORD>
3. **Set up variables:**
   - Go to **Settings** > **Actions** > **Variables**.
   - Create the following variables:
     - `MAX_FUEL_PRICE`: 550 (Set your desired price. The bot will buy fuel if the current price is lower.)
     - `MAX_CO2_PRICE`: 120 (Same as fuel.)
   - If you want bot to start a campaign to increase airline reputation you need to set these variables:
     - `INCREASE_AIRLINE_REPUTATION`: true
     - `CAMPAIGN_TYPE`: 1 (You can set this to your desired campaign type)
     - `CAMPAIGN_DURATION`: 4 (Again you can set this to your desired campaign duration)
4. **Enable workflows:**
   - Go to **Actions** and enable workflows.
5. The workflow will now be triggered twice every hour at 01 and 31 minutes.

## Reliable scheduling (external trigger)
GitHub's own cron is best-effort and can skip many runs. For on-time runs, have an external scheduler (for example [cron-job.org](https://cron-job.org)) start the workflow through the GitHub API:

- **URL:** `https://api.github.com/repos/<your-username>/<your-repo>/actions/workflows/playwright.yml/dispatches`
- **Method:** `POST`
- **Headers:** `Authorization: Bearer <fine-grained token>`, `Accept: application/vnd.github+json`, `Content-Type: application/json`
- **Body:** `{"ref":"main","inputs":{"task":"resources"}}` every 15 minutes (fuel and CO2 only), and `{"ref":"main","inputs":{"task":"full"}}` every 30 minutes (everything).
- **Token:** create a fine-grained personal access token limited to this one repository with **Actions: Read and write**. Keep it only in the scheduler, never in the repo.

The built-in cron is kept as a backup, and a concurrency rule makes sure two runs never use the game account at the same time.

## Notes
- Language of your game must be **English** for this bot to work.
- Trigger times may vary due to heavy loads on GitHub Actions.
- To change the schedule, edit the **cron** expression under **schedule** in `.github/workflows/playwright.yml`. Use [crontab.guru](https://crontab.guru/) to generate your desired cron expression.
- If you don't want your repo to be public you can clone this project and commit it to your private repo.
- For questions, reach out on Discord: `muhittin852`.

## Automatic pricing

Actions -> Playwright Tests -> Run workflow -> task `pricing`.

1. `pricing_mode = inspect` (default): read-only, logs the page structure and the first route.
2. `dry-run`: logs the prices it would set for `pricing_max_routes` routes, saves nothing.
3. `live`: saves the prices. Start with a few routes, then set `pricing_max_routes` to 0 (all).

Price = game auto price x multiplier (Y 1.10, J 1.08, F 1.06 by default) minus a $3 guard.
Optional repository variables: `PRICING_GAME_MODE` (realism|easy), `PRICE_MULT_Y/J/F` (1.0-1.15), `PRICE_MARGIN`.
Passenger routes only; cargo is skipped.

Notes on pricing: only routes whose aircraft is on the ground show a distance, so only those are priced; routes in
flight are skipped and picked up on a later run. Prices set by hand (outside 0.99x-1.20x of auto) are left alone;
prices far below auto are repaired. Routes are found by name, not position, because the list reorders as planes land.
