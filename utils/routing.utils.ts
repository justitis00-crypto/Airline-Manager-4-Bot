import { Locator, Page } from "@playwright/test";
import { GeneralUtils } from "./general.utils";

require('dotenv').config();

/**
 * inspect : read-only. Looks at the first parked plane, asks the game for international routes and logs what it
 *           offers (and the page structure). Creates nothing.
 * dry-run : read-only. Same, but stops at the first suggestion that meets the rules and says it would take it.
 * live    : takes the first suggestion that meets the rules and presses "Next", which creates the route.
 *           It then logs the screen that follows and stops.
 */
export type RoutingMode = 'inspect' | 'dry-run' | 'live';

export interface RoutingOptions {
    mode: RoutingMode;
    minEconomy: number;   // minimum economy demand of the destination
    minHours: number;     // minimum flight time in hours
    attempts: number;     // how many suggestions to look at per plane
    maxPlanes: number;    // how many parked planes to handle per run
}

export interface Suggestion {
    from: string;
    to: string;
    km: number;
    y: number;
    j: number;
    f: number;
    aircraftOnRoute: number;
    hours: number;        // flight time
}

export class RoutingUtils {
    page: Page;
    options: RoutingOptions;
    private structureLogged = false;

    constructor(page: Page, options: RoutingOptions) {
        this.page = page;
        this.options = options;
    }

    // ---------- Settings ----------

    public static optionsFromEnv(): RoutingOptions {
        const raw = (process.env.ROUTING_MODE || 'inspect').trim().toLowerCase();
        const mode: RoutingMode = raw === 'live' || raw === 'dry-run' ? raw : 'inspect';
        return {
            mode,
            minEconomy: RoutingUtils.envNumber('ROUTING_MIN_ECONOMY', 1000, 1, 100000),
            minHours: RoutingUtils.envNumber('ROUTING_MIN_HOURS', 8, 0, 48),
            attempts: Math.floor(RoutingUtils.envNumber('ROUTING_ATTEMPTS', 25, 1, 200)),
            maxPlanes: Math.floor(RoutingUtils.envNumber('ROUTING_MAX_PLANES', 1, 1, 50)),
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

    // ---------- Pure logic (no page needed) ----------

    /** Reads the route panel text: "KLAX 14,014km OEGN ... PAX Demand 650/166/254 A/C on route 0". */
    public static parseSuggestion(text: string): Suggestion | null {
        const t = text.replace(/\s+/g, ' ');
        const route = t.match(/\b([A-Z]{4}) ?([\d.,]+) ?km ?([A-Z]{4})\b/);
        const demand = t.match(/PAX Demand ?(\d+) ?\/ ?(\d+) ?\/ ?(\d+)/);
        const onRoute = t.match(/A\/C on route ?(\d+)/);
        const time = t.match(/Flight time ?(\d+):(\d{2}):(\d{2})/);
        if (!route || !demand || !onRoute || !time) return null;
        const km = Number.parseInt(route[2].replace(/[^\d]/g, ''), 10);
        return {
            from: route[1],
            to: route[3],
            km,
            y: Number.parseInt(demand[1], 10),
            j: Number.parseInt(demand[2], 10),
            f: Number.parseInt(demand[3], 10),
            aircraftOnRoute: Number.parseInt(onRoute[1], 10),
            hours: Number.parseInt(time[1], 10) + Number.parseInt(time[2], 10) / 60 + Number.parseInt(time[3], 10) / 3600,
        };
    }

    /**
     * The rules: enough economy demand, a long enough flight, and none of our aircraft already flies this hub-to-destination pair.
     * (A destination served from a different hub is fine, because "A/C on route" counts this pair only.)
     */
    public static qualifies(s: Suggestion, o: RoutingOptions, taken: Set<string>): { ok: boolean; why: string } {
        if (s.y < o.minEconomy) return { ok: false, why: `economy demand ${s.y} < ${o.minEconomy}` };
        if (s.hours < o.minHours) return { ok: false, why: `flight time ${s.hours.toFixed(1)} h < ${o.minHours} h` };
        if (s.aircraftOnRoute > 0) return { ok: false, why: `already ${s.aircraftOnRoute} of our aircraft on this route` };
        if (taken.has(`${s.from}-${s.to}`)) return { ok: false, why: 'already chosen for another plane in this run' };
        return { ok: true, why: 'meets the rules' };
    }

    private static describe(s: Suggestion): string {
        return `${s.from} -> ${s.to} | ${s.km} km | demand Y ${s.y} / J ${s.j} / F ${s.f} | ${s.hours.toFixed(1)} h | our aircraft on it: ${s.aircraftOnRoute}`;
    }

    // ---------- Main flow ----------

    public async run(): Promise<void> {
        const o = this.options;
        console.log(`Routing mode: ${o.mode} | min economy demand: ${o.minEconomy} | min flight: ${o.minHours} h | suggestions per plane: ${o.attempts} | planes: ${o.maxPlanes}`);

        const taken = new Set<string>();
        let handled = 0;
        let finished = false;

        // New aircraft always wait under the "Parked" tab.
        for (const tab of ['Parked']) {
            if (handled >= o.maxPlanes || finished) break;

            const names = await this.openList(tab);
            console.log(`${tab} tab: ${names.length} aircraft ${JSON.stringify(names.slice(0, 12))}`);
            if (names.length === 0) continue;

            for (let i = 0; i < Math.min(names.length, 8) && handled < o.maxPlanes && !finished; i++) {
                if (i > 0) await this.openList(tab);

                await this.planeRows().nth(i).click();
                await GeneralUtils.sleep(1500);

                // A plane that already has a route (for example one back from repairs) shows Depart/Reroute.
                // The regular bot departs those, so they are left completely alone.
                const alreadyRouted = await this.byText('Depart').isVisible().catch(() => false)
                    || await this.byText('Reroute').isVisible().catch(() => false);
                if (alreadyRouted) {
                    console.log(`${tab} aircraft ${i + 1} (${names[i]}): already has a route (Depart/Reroute shown). Ignored.`);
                    continue;
                }
                if (!(await this.byText('Intl route').isVisible().catch(() => false))) {
                    console.log(`${tab} aircraft ${i + 1} (${names[i]}): no "Intl route" button, so it cannot be given a route now. Skipping.`);
                    continue;
                }
                console.log(`Using ${tab.toLowerCase()} aircraft ${names[i]}.`);

                const chosen = await this.findRoute(taken);
                handled++;

                if (!chosen) {
                    console.log('No suggestion met the rules within the attempt limit (or inspect mode). Nothing created.');
                    finished = true;
                    break;
                }
                taken.add(`${chosen.from}-${chosen.to}`);
                if (o.mode === 'live') {
                    console.log('Taking this route: pressing Next, which creates it.');
                    await this.byText('Next').click();
                    await GeneralUtils.sleep(2000);
                    await this.logStructure('screen after Next');
                    finished = true;
                }
            }
        }

        if (handled === 0) console.log('No aircraft could be given a route. Nothing to do.');
        console.log(`Routing finished (${o.mode}).`);
    }

    /** Asks the game for international routes and cycles through them until one meets the rules. */
    private async findRoute(taken: Set<string>): Promise<Suggestion | null> {
        const o = this.options;
        await this.byText('Intl route').click();
        await GeneralUtils.sleep(2000);

        for (let i = 1; i <= o.attempts; i++) {
            const text = await this.near('PAX Demand', 200, 400);
            const s = RoutingUtils.parseSuggestion(text);

            if (!s) {
                console.log(`Suggestion ${i}: could not read it. Text near it: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
                await this.logStructure('route panel');
                return null;
            }

            const verdict = RoutingUtils.qualifies(s, o, taken);
            console.log(`Suggestion ${i}: ${RoutingUtils.describe(s)} | ${verdict.ok ? 'MEETS THE RULES' : 'no: ' + verdict.why}`);
            if (i === 1) await this.logStructure('route panel');

            if (verdict.ok && o.mode !== 'inspect') return s;
            if (o.mode === 'inspect' && i >= Math.min(o.attempts, 5)) return null;

            await this.byText('Other intl routes').click();
            await GeneralUtils.sleep(1500);
        }
        return null;
    }

    // ---------- Page helpers ----------

    private byText(label: string): Locator {
        return this.page.getByText(label, { exact: true }).first();
    }

    /** Aircraft names shown in the list on the left (only the ones you can currently see). */
    private planeRows(): Locator {
        return this.page.locator('text=/^ET-[\\w-]+$/ >> visible=true');
    }

    /** Opens one tab of the aircraft list (Parked, Pending...) and returns the aircraft names it shows. */
    private async openList(tabName: string): Promise<string[]> {
        let tab = this.byText(tabName);
        if (!(await tab.isVisible().catch(() => false))) {
            // An aircraft panel is open: its "List" button goes back to the list.
            await this.byText('List').click({ timeout: 3000 }).catch(() => undefined);
            await GeneralUtils.sleep(1000);
            tab = this.byText(tabName);
        }
        if (!(await tab.isVisible().catch(() => false))) {
            await this.logStructure(`page without a ${tabName} tab`);
            throw new Error(`Could not find the "${tabName}" tab of the aircraft list.`);
        }
        await tab.click();
        await GeneralUtils.sleep(2000);

        const names = (await this.planeRows().allInnerTexts().catch(() => [] as string[]))
            .map((t: string) => t.trim()).filter(Boolean);
        if (names.length === 0) await this.logStructure(`${tabName} tab without aircraft`);
        return names;
    }

    /** Text of the page around an anchor phrase, so logs never include the account balance. */
    private async near(anchor: string, before: number, after: number): Promise<string> {
        const body: string = await this.page.locator('body').innerText().catch(() => '');
        const at = body.indexOf(anchor);
        if (at < 0) return '';
        return body.slice(Math.max(0, at - before), at + after);
    }

    private async logStructure(label: string) {
        if (this.structureLogged && label !== 'screen after Next') return;
        this.structureLogged = label !== 'screen after Next';

        console.log(`--- STRUCTURE: ${label} ---`);
        const buttons = (await this.page.locator('button:visible, .btn:visible').allInnerTexts().catch(() => [] as string[]))
            .map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 25);
        console.log(`visible buttons: ${JSON.stringify(buttons)}`);

        const inputs = this.page.locator('input:visible:not([type=hidden])');
        const n = await inputs.count().catch(() => 0);
        console.log(`visible inputs: ${n}`);
        for (let i = 0; i < Math.min(n, 8); i++) {
            const info = await inputs.nth(i).evaluate((el: Element) => {
                const e = el as HTMLInputElement;
                return `type=${e.type} id=${e.id} placeholder=${e.placeholder} value=${e.value}`;
            }).catch(() => 'n/a');
            console.log(`  input ${i + 1}: ${info}`);
        }

        const selects = await this.page.locator('select:visible').count().catch(() => 0);
        console.log(`visible dropdowns: ${selects}`);
        console.log('--- END STRUCTURE ---');
    }
}
