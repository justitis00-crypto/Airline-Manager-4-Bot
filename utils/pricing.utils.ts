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

interface ListRow { key: string; km: number | null; flying: boolean; page: number; }

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

    // ---------- Decision logic (no page needed) ----------

    /**
     * Decides what to do with a route, using the distance from the route list and the prices on the page.
     * - prices within 0.99x-1.20x of the game's auto price: ours (or untouched) -> set / keep the target
     * - prices below 0.6x the auto price: clearly broken -> repair to the target
     * - anything else: probably set by hand -> leave alone
     */
    public static decide(current: Prices, km: number, o: PricingOptions): { action: 'set' | 'same' | 'skip'; target: Prices; note: string } {
        const auto = PricingUtils.autoPrices(km, o.gameMode);
        const target = PricingUtils.targetPrices(auto, o.multipliers, o.margin);
        const ratios = [current.y / auto.y, current.j / auto.j, current.f / auto.f];
        const inBand = ratios.every(r => r >= 0.99 && r <= 1.20);

        if (inBand) {
            const same = current.y === target.y && current.j === target.j && current.f === target.f;
            return { action: same ? 'same' : 'set', target, note: same ? 'already at target' : '' };
        }
        if (current.y < 0.6 * auto.y) {
            return { action: 'set', target, note: `REPAIR (prices were far below auto ${PricingUtils.fmt(auto)})` };
        }
        return { action: 'skip', target, note: `left alone: prices are outside the normal range (auto is ${PricingUtils.fmt(auto)}); set by hand?` };
    }

    /** "#ET-0026 BKPR - OMRK ET-060 - MC-21-400": identifies one route row whatever its position in the list. */
    public static rowKey(text: string): string | null {
        const t = text.replace(/\s+/g, ' ').trim();
        const start = t.indexOf('#');
        if (start < 0) return null;
        const rest = t.slice(start);
        const cut = rest.search(/\s(Demand|Onboard):/);
        return (cut > 0 ? rest.slice(0, cut) : rest).trim();
    }

    // ---------- Main flow ----------

    private static readonly TIME_LIMIT_MS = 33 * 60 * 1000;

    public async run(): Promise<void> {
        const o = this.options;
        const started = Date.now();
        console.log(`Pricing mode: ${o.mode} | game: ${o.gameMode} | max routes: ${o.maxRoutes === 0 ? 'all' : o.maxRoutes}`);
        console.log(`Multipliers Y/J/F: ${o.multipliers.y} / ${o.multipliers.j} / ${o.multipliers.f} | margin: $${o.margin}`);
        console.log('Only routes whose aircraft is on the ground are priced; routes in flight are skipped (their row shows no distance).');

        await this.openRoutes();
        console.log(`Routes in game: ${(await this.readRouteTotal()) ?? 'unknown'}`);

        const done = new Set<string>();
        const stats = { changed: 0, same: 0, skipped: 0, flying: 0, failed: 0 };
        const limit = o.mode === 'inspect' ? 1 : (o.maxRoutes === 0 ? Infinity : o.maxRoutes);
        let handled = 0, consecutiveFailures = 0, startPage = 1;

        while (handled < limit) {
            if (Date.now() - started > PricingUtils.TIME_LIMIT_MS) {
                console.log('Time limit reached. Run again to continue; routes already at target are quick.');
                break;
            }

            let row = await this.scan(startPage, Infinity, done, stats);
            if (!row && startPage > 1) {
                await this.closeModal();
                await this.openRoutes();
                row = await this.scan(1, startPage - 1, done, stats);
            }
            if (!row) break;

            startPage = row.page;
            done.add(row.key);
            handled++;

            try {
                const result = await this.processRow(handled, row);
                stats[result]++;
                consecutiveFailures = 0;
            } catch (error) {
                stats.failed++;
                consecutiveFailures++;
                const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
                console.log(`Route ${handled}: FAILED - ${message}`);
                await this.inspectDetail(true);
                if (consecutiveFailures >= 3) {
                    console.log('Stopping: 3 routes failed in a row.');
                    break;
                }
            }

            await this.closeModal();
            await this.openRoutes();
        }

        const verb = o.mode === 'live' ? 'Updated' : 'Would update';
        console.log(`Pricing finished. ${verb}: ${stats.changed} | already at target: ${stats.same} | left alone: ${stats.skipped} | in flight (skipped): ${stats.flying} | failed: ${stats.failed}`);
        if (stats.failed > 0) {
            throw new Error(`${stats.failed} route(s) failed. See the log above.`);
        }
    }

    /** Walks the list pages from..to (list must be open on page 1) and returns the first route not handled yet. */
    private async scan(from: number, to: number, done: Set<string>, stats: { flying: number }): Promise<ListRow | null> {
        let previous = '';
        for (let page = 1; page <= to; page++) {
            if (page > 1 && !(await this.nextPage(previous))) return null;

            const rows = await this.readRows();
            previous = rows.map(r => r.key).join('|');
            if (page < from) continue;

            for (const r of rows) {
                if (done.has(r.key)) continue;
                if (r.flying || r.km === null) {
                    done.add(r.key);
                    stats.flying++;
                    continue;
                }
                return { ...r, page };
            }
        }
        return null;
    }

    private async processRow(number: number, row: ListRow): Promise<'changed' | 'same' | 'skipped' | 'flying'> {
        const o = this.options;

        // The list is already on the page where the row was found. Find it again by name (positions move).
        const rows = this.routeRows();
        const count = await rows.count();
        let index = -1;
        for (let i = 0; i < count; i++) {
            const text = await rows.nth(i).innerText({ timeout: 3000 }).catch(() => '');
            if (PricingUtils.rowKey(text) === row.key) { index = i; break; }
        }
        if (index < 0) throw new Error('route is no longer on that list page (the list moved)');

        if (!this.listInspected) {
            this.listInspected = true;
            console.log(`List structure: row=${await this.chain(rows.nth(index))}`);
        }

        await rows.nth(index).getByText(/^#[\w-]+$/).first().click();
        await GeneralUtils.sleep(1500);

        if (!(await this.seatHeader().isVisible())) {
            const link = rows.nth(index).locator('a').first();
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
        const inputCount = await inputs.count();
        if (inputCount !== 3) {
            console.log(`Route ${number}: ${row.key} | skipped - found ${inputCount} price boxes (expected 3 for a passenger aircraft).`);
            return 'skipped';
        }

        const current = await this.readPrices(inputs);
        const decision = PricingUtils.decide(current, row.km as number, o);
        const line = `Route ${number}: ${row.key} | ${row.km} km | now ${PricingUtils.fmt(current)} | target ${PricingUtils.fmt(decision.target)}`;

        if (decision.action === 'same') { console.log(`${line} | ${decision.note}`); return 'same'; }
        if (decision.action === 'skip') { console.log(`${line} | ${decision.note}`); return 'skipped'; }

        const note = decision.note ? ` ${decision.note}` : '';
        if (o.mode !== 'live') {
            console.log(`${line} | WOULD CHANGE (${o.mode}, nothing saved)${note}`);
            return 'changed';
        }

        const t = decision.target;
        await inputs.nth(0).fill(String(t.y));
        await inputs.nth(1).fill(String(t.j));
        await inputs.nth(2).fill(String(t.f));
        await this.saveButton().click();
        await GeneralUtils.sleep(1500);

        const after = await this.readPrices(this.priceInputs());
        const ok = after.y === t.y && after.j === t.j && after.f === t.f;
        console.log(`${line} | SAVED${ok ? '' : ` (WARNING: page now shows ${PricingUtils.fmt(after)})`}${note}`);
        return 'changed';
    }

    private async readRows(): Promise<ListRow[]> {
        const texts = await this.routeRows().allInnerTexts();
        const rows: ListRow[] = [];
        for (const t of texts) {
            const key = PricingUtils.rowKey(t);
            if (key) rows.push({ key, km: PricingUtils.parseKm(t), flying: /Onboard:/.test(t), page: 0 });
        }
        return rows;
    }

    private async nextPage(previous: string): Promise<boolean> {
        try {
            await this.popup.getByText('Next', { exact: true }).first().click({ timeout: 5000 });
        } catch {
            return false;
        }
        await GeneralUtils.sleep(1200);
        if (previous === '') return true;
        const now = (await this.readRows()).map(r => r.key).join('|');
        return now !== '' && now !== previous;
    }

    // ---------- Page helpers ----------

    private get popup(): Locator {
        return this.page.locator('#popup');
    }


    private routeRows(): Locator {
        return this.popup.locator('div[id^="routeMainList"]');
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
