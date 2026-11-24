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

        while (handled < o.maxPlanes) {
            const count = await this.openParkedList();
            if (count === 0) {
                console.log(handled === 0 ? 'No parked aircraft found. Nothing to do.' : 'No more parked aircraft.');
                break;
            }
            console.log(`Parked aircraft found: ${count}`);

            await this.parkedRows().nth(handled).click();
            await GeneralUtils.sleep(1500);
            const planeText = await this.near('New route', 0, 400);
            console.log(`Aircraft panel: ${planeText.slice(0, 160)}`);

            const chosen = await this.findRoute(taken);
            handled++;

            if (!chosen) {
                console.log('No suggestion met the rules within the attempt limit. Run again later or raise the attempts.');
                break;
            }
            taken.add(`${chosen.from}-${chosen.to}`);
            if (o.mode === 'live') {
                console.log('Taking this route: pressing Next, which creates it.');
                await this.byText('Next').click();
                await GeneralUtils.sleep(2000);
                await this.logStructure('screen after Next');
                break;
            }
            break;
        }

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

    private parkedRows(): Locator {
        // The status may sit in its own element or inside a longer row text, so match it as a word.
        return this.page.getByText(/\bPARKED\b/);
    }

    /** Opens the aircraft list on the left and shows the Parked tab. Returns how many parked aircraft there are. */
    private async openParkedList(): Promise<number> {
        const tab = this.byText('Parked');
        if (!(await tab.isVisible().catch(() => false))) {
            await this.logStructure('page without a Parked tab');
            throw new Error('Could not find the "Parked" tab of the aircraft list.');
        }
        await tab.click();

        let count = 0;
        for (let i = 0; i < 8; i++) {
            await GeneralUtils.sleep(1000);
            count = await this.parkedRows().count();
            if (count > 0) break;
        }
        if (count === 0) {
            const planes = (await this.page.getByText(/\bET-[\w-]+/).allInnerTexts().catch(() => [] as string[]))
                .map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length < 80).slice(0, 12);
            console.log(`Nothing marked PARKED after opening the Parked tab. Aircraft texts on screen: ${JSON.stringify(planes)}`);
            await this.logStructure('Parked tab without rows');
        }
        return count;
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
