import { Locator, Page } from "@playwright/test";
import { GeneralUtils } from "./general.utils";

require('dotenv').config();

/**
 * inspect : read-only. Logs how the page is built (to find selectors) and what it would do for the first route.
 * dry-run : read-only. Logs the prices it would set for up to PRICING_MAX_ROUTES routes.
 * live    : sets the prices and presses Save.
 */
export type PricingMode = 'inspect' | 'dry-run' | 'live';
export type GameMode = 'realism' | 'easy';

export interface Prices { y: number; j: number; f: number; }

export interface PricingOptions {
    mode: PricingMode;
    gameMode: GameMode;
    maxRoutes: number;     // 0 = every route
    multipliers: Prices;   // price = autoprice * multiplier
    margin: number;        // dollars subtracted as a rounding guard
}

export class PricingUtils {
    // Auto price formulas (slope * km + intercept) for passenger aircraft.
    // Source: community AM4 formulae page (abc8747.github.io/am4/formulae).
    static readonly FORMULAS: Record<GameMode, { y: [number, number]; j: [number, number]; f: [number, number] }> = {
        realism: { y: [0.3, 150], j: [0.6, 500], f: [0.9, 1000] },
        easy:    { y: [0.4, 170], j: [0.8, 560], f: [1.2, 1200] },
    };

    // "Optimal" multipliers above the auto price for passenger aircraft (same source).
    static readonly DEFAULT_MULTIPLIERS: Prices = { y: 1.10, j: 1.08, f: 1.06 };

    // Safety limits for the multipliers, so a typo can never price flights out of the market.
    static readonly MIN_MULTIPLIER = 1.0;
    static readonly MAX_MULTIPLIER = 1.15;

    page: Page;
    options: PricingOptions;
    private listInspected = false;
    private detailInspected = false;

    constructor(page: Page, options: PricingOptions) {
        this.page = page;
        this.options = options;
    }

    // ---------- Settings ----------

    public static optionsFromEnv(): PricingOptions {
        const rawMode = (process.env.PRICING_MODE || 'inspect').trim().toLowerCase();
        const mode: PricingMode = rawMode === 'live' || rawMode === 'dry-run' ? rawMode : 'inspect';

        const rawGame = (process.env.PRICING_GAME_MODE || 'realism').trim().toLowerCase();
        const gameMode: GameMode = rawGame === 'easy' ? 'easy' : 'realism';

        const d = PricingUtils.DEFAULT_MULTIPLIERS;
        return {
            mode,
            gameMode,
            maxRoutes: Math.floor(PricingUtils.envNumber('PRICING_MAX_ROUTES', 3, 0, 1000)),
            multipliers: {
                y: PricingUtils.envNumber('PRICE_MULT_Y', d.y, PricingUtils.MIN_MULTIPLIER, PricingUtils.MAX_MULTIPLIER),
                j: PricingUtils.envNumber('PRICE_MULT_J', d.j, PricingUtils.MIN_MULTIPLIER, PricingUtils.MAX_MULTIPLIER),
                f: PricingUtils.envNumber('PRICE_MULT_F', d.f, PricingUtils.MIN_MULTIPLIER, PricingUtils.MAX_MULTIPLIER),
            },
            margin: Math.floor(PricingUtils.envNumber('PRICE_MARGIN', 3, 0, 50)),
        };
    }

    private static envNumber(name: string, fallback: number, min: number, max: number): number {
        const raw = (process.env[name] || '').trim();
        if (raw === '') return fallback;

        const value = Number(raw);
        if (!Number.isFinite(value) || value < min || value > max) {
            throw new Error(`${name} must be a number between ${min} and ${max}, got "${raw}"`);
        }
        return value;
    }

    // ---------- Math (no page needed) ----------

    /** The game's auto price for a route of the given distance. The game rounds up. */
    public static autoPrices(km: number, gameMode: GameMode): Prices {
        const f = PricingUtils.FORMULAS[gameMode];
        return {
            y: Math.ceil(f.y[0] * km + f.y[1]),
            j: Math.ceil(f.j[0] * km + f.j[1]),
            f: Math.ceil(f.f[0] * km + f.f[1]),
        };
    }

    /** auto price * multiplier, minus a small guard against rounding, and never below the auto price. */
    public static targetPrices(auto: Prices, multipliers: Prices, margin: number): Prices {
        const calc = (a: number, m: number) => Math.max(a, Math.floor(a * m) - margin);
        return { y: calc(auto.y, multipliers.y), j: calc(auto.j, multipliers.j), f: calc(auto.f, multipliers.f) };
    }

    private static fmt(p: Prices): string {
        return `Y ${p.y} / J ${p.j} / F ${p.f}`;
    }

    // ---------- Main flow ----------

    public async run(): Promise<void> {
        const o = this.options;
        console.log(`Pricing mode: ${o.mode} | game: ${o.gameMode} | max routes: ${o.maxRoutes === 0 ? 'all' : o.maxRoutes}`);
        console.log(`Multipliers Y/J/F: ${o.multipliers.y} / ${o.multipliers.j} / ${o.multipliers.f} | margin: $${o.margin}`);

        await this.openRoutes();

        const total = await this.readRouteTotal();
        const pageSize = await this.routeIds().count();
        console.log(`Routes in game: ${total ?? 'unknown'} | routes on first page: ${pageSize}`);

        if (pageSize === 0) {
            await this.inspectList(null);
            throw new Error('Could not find any routes in the list (see the structure lines above).');
        }

        const routeCount = total ?? pageSize;
        let limit = o.maxRoutes === 0 ? routeCount : Math.min(routeCount, o.maxRoutes);
        if (o.mode === 'inspect') limit = Math.min(limit, 1);

        let changed = 0, same = 0, skipped = 0, failed = 0, consecutiveFailures = 0;

        for (let k = 0; k < limit; k++) {
            const pageNo = Math.floor(k / pageSize) + 1;
            const index = k % pageSize;

            try {
                if (k > 0) {
                    await this.closeModal();
                    await this.openRoutes();
                }
                await this.goToListPage(pageNo);

                const result = await this.processRoute(k + 1, index);
                if (result === 'changed') changed++;
                else if (result === 'same') same++;
                else skipped++;
                consecutiveFailures = 0;
            } catch (error) {
                failed++;
                consecutiveFailures++;
                const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
                console.log(`Route ${k + 1}: FAILED - ${message}`);
                await this.inspectDetail();

                if (consecutiveFailures >= 3) {
                    console.log('Stopping: 3 routes failed in a row.');
                    break;
                }
            }
        }

        console.log(`Pricing finished. ${o.mode === 'live' ? 'Updated' : 'Would update'}: ${changed} | already at target: ${same} | skipped: ${skipped} | failed: ${failed}`);

        if (failed > 0) {
            throw new Error(`${failed} route(s) failed. See the log above.`);
        }
    }

    private async processRoute(number: number, index: number): Promise<'changed' | 'same' | 'skipped'> {
        const id = this.routeIds().nth(index);
        await id.waitFor({ state: 'visible', timeout: 10000 });

        // Distance comes from the list row (for example "9,928KM").
        const rowText = await id.locator('xpath=ancestor::*[contains(., "KM")][1]').innerText().catch(() => '');
        const km = PricingUtils.parseKm(rowText);

        if (!this.listInspected) {
            await this.inspectList(id, rowText);
        }

        if (km === null) {
            console.log(`Route ${number}: skipped - could not read the distance from the list row.`);
            return 'skipped';
        }

        await id.click();
        await GeneralUtils.sleep(1500);

        if (!(await this.seatHeader().isVisible())) {
            // Some versions open the page from the aircraft link instead of the route number.
            const row = id.locator('xpath=ancestor::*[contains(., "KM")][1]');
            const link = row.getByText(/^\S+ - \S+$/).filter({ hasNotText: /^[A-Z]{4} - [A-Z]{4}$/ }).first();
            if (await link.isVisible().catch(() => false)) {
                await link.click();
                await GeneralUtils.sleep(1500);
            }
        }

        if (!(await this.seatHeader().isVisible())) {
            throw new Error('Could not open the route page (no "Seat layout" section found).');
        }

        await this.ensureSeatPanelOpen();
        await this.inspectDetail(true);

        const inputs = this.priceInputs();
        const count = await inputs.count();
        if (count !== 3) {
            console.log(`Route ${number}: skipped - found ${count} price boxes (expected 3 for a passenger aircraft).`);
            return 'skipped';
        }

        const current = await this.readPrices(inputs);
        const auto = PricingUtils.autoPrices(km, this.options.gameMode);
        const target = PricingUtils.targetPrices(auto, this.options.multipliers, this.options.margin);

        const line = `Route ${number}: ${km} km | now ${PricingUtils.fmt(current)} | auto ${PricingUtils.fmt(auto)} | target ${PricingUtils.fmt(target)}`;

        if (current.y === target.y && current.j === target.j && current.f === target.f) {
            console.log(`${line} | already at target`);
            return 'same';
        }

        if (this.options.mode !== 'live') {
            console.log(`${line} | WOULD CHANGE (${this.options.mode}, nothing saved)`);
            return 'changed';
        }

        await inputs.nth(0).fill(String(target.y));
        await inputs.nth(1).fill(String(target.j));
        await inputs.nth(2).fill(String(target.f));
        await this.saveButton().click();
        await GeneralUtils.sleep(1500);

        const after = await this.readPrices(this.priceInputs());
        const ok = after.y === target.y && after.j === target.j && after.f === target.f;
        console.log(`${line} | SAVED${ok ? '' : ` (WARNING: page now shows ${PricingUtils.fmt(after)})`}`);
        return 'changed';
    }

    // ---------- Page helpers ----------

    private get popup(): Locator {
        return this.page.locator('#popup');
    }

    private routeIds(): Locator {
        return this.popup.getByText(/^#[\w-]+$/);
    }

    private seatHeader(): Locator {
        return this.popup.getByText('seat layout').first();
    }

    private priceInputs(): Locator {
        return this.popup.locator('input:visible:not([type=checkbox]):not([type=radio]):not([type=hidden])');
    }

    private autoButton(): Locator {
        return this.popup.locator('button:text-is("Auto"), a:text-is("Auto"), .btn:text-is("Auto")');
    }

    private saveButton(): Locator {
        return this.popup.locator('button:text-is("Save"), a:text-is("Save"), .btn:text-is("Save")').first();
    }

    private async openRoutes() {
        await this.page.locator('#mapRoutes').getByRole('img').click();
        await GeneralUtils.sleep(2500);
    }

    private async closeModal() {
        try {
            await this.page.locator('#popup > .modal-dialog > .modal-content > .modal-header > div > .glyphicons').click({ timeout: 5000 });
        } catch {
            await this.page.keyboard.press('Escape');
        }
        await GeneralUtils.sleep(800);
    }

    private async goToListPage(pageNo: number) {
        for (let i = 1; i < pageNo; i++) {
            await this.popup.getByText('Next', { exact: true }).first().click();
            await GeneralUtils.sleep(1500);
        }
    }

    private async ensureSeatPanelOpen() {
        if ((await this.priceInputs().count()) === 0) {
            await this.seatHeader().click();
            await GeneralUtils.sleep(1000);
        }
    }

    private async readRouteTotal(): Promise<number | null> {
        const text = await this.popup.innerText().catch(() => '');
        const match = text.match(/(\d+)\s*ROUTES/i) || text.match(/Routes\s*\((\d+)\)/i);
        return match ? Number.parseInt(match[1], 10) : null;
    }

    private async readPrices(inputs: Locator): Promise<Prices> {
        const read = async (i: number) => Number.parseInt((await inputs.nth(i).inputValue()).replace(/[^\d]/g, ''), 10);
        return { y: await read(0), j: await read(1), f: await read(2) };
    }

    private static parseKm(text: string): number | null {
        const match = text.match(/([\d.,]+)\s*KM/i);
        if (!match) return null;
        const km = Number.parseInt(match[1].replace(/[^\d]/g, ''), 10);
        return Number.isFinite(km) && km > 0 ? km : null;
    }

    // ---------- Diagnostics (logs page structure, never account data) ----------

    private async chain(locator: Locator): Promise<string> {
        try {
            return await locator.first().evaluate((el: Element) => {
                const parts: string[] = [];
                let node: Element | null = el;
                for (let i = 0; i < 6 && node; i++) {
                    const id = node.id ? '#' + node.id : '';
                    const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).map(c => '.' + c).join('');
                    parts.push(node.tagName.toLowerCase() + id + cls);
                    node = node.parentElement;
                }
                return parts.join(' < ');
            });
        } catch {
            return 'n/a';
        }
    }

    private async inspectList(id: Locator | null, rowText = '') {
        this.listInspected = true;
        console.log('--- STRUCTURE: routes list ---');
        console.log(`route ids found: ${await this.routeIds().count()}`);
        if (id) {
            console.log(`route id element: ${await this.chain(id)}`);
            console.log(`row element: ${await this.chain(id.locator('xpath=ancestor::*[contains(., "KM")][1]'))}`);
            console.log(`row text: ${rowText.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
        }
        console.log(`"Next" element: ${await this.chain(this.popup.getByText('Next', { exact: true }))}`);
        const links = (await this.popup.locator('a').allInnerTexts().catch(() => [] as string[])).map(t => t.trim()).filter(Boolean).slice(0, 8);
        console.log(`first links: ${JSON.stringify(links)}`);
        console.log('--- END STRUCTURE ---');
    }

    private async inspectDetail(onlyOnce = false) {
        if (onlyOnce && this.detailInspected) return;
        this.detailInspected = true;

        console.log('--- STRUCTURE: route page ---');
        console.log(`"seat layout" header: ${await this.chain(this.seatHeader())}`);

        const inputs = this.priceInputs();
        const count = await inputs.count().catch(() => 0);
        console.log(`visible input boxes: ${count}`);
        for (let i = 0; i < Math.min(count, 5); i++) {
            const info = await inputs.nth(i).evaluate((el: Element) => {
                const e = el as HTMLInputElement;
                return `type=${e.type} id=${e.id} name=${e.name} placeholder=${e.placeholder} value=${e.value}`;
            }).catch(() => 'n/a');
            console.log(`  input ${i + 1}: ${info}`);
        }

        console.log(`Auto button(s): ${await this.autoButton().count().catch(() => 0)} -> ${await this.chain(this.autoButton())}`);
        console.log(`Save button(s): ${await this.popup.locator('button:text-is("Save"), a:text-is("Save"), .btn:text-is("Save")').count().catch(() => 0)} -> ${await this.chain(this.saveButton())}`);

        const buttons = (await this.popup.locator('button:visible, a.btn:visible').allInnerTexts().catch(() => [] as string[]))
            .map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 15);
        console.log(`visible buttons: ${JSON.stringify(buttons)}`);
        console.log('--- END STRUCTURE ---');
    }
}
