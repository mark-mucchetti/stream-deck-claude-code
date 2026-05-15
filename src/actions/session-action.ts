import streamDeck, {
	action,
	SingletonAction,
	type KeyDownEvent,
	type SendToPluginEvent,
	type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/streamdeck";
import { focusSession } from "../focus.js";
import { ANIM_TICK_MS, brightnessFor, captionWillScroll, renderEmpty, renderSession, shouldAnimate } from "../render.js";
import type { SessionStore } from "../state.js";
import { installHooks, isInstalled, uninstallHooks } from "../install.js";

type Settings = Record<string, never>;

@action({ UUID: "com.virtuis.claudecode.session" })
export class SessionAction extends SingletonAction<Settings> {
	private store!: SessionStore;
	private port = 0;
	private busy = false;
	private animPhase = 0;
	// Per-slot last-painted brightness, so we can skip RPCs when the new
	// frame would look identical (or near-identical).
	private lastBrightness = new Map<string, number>();
	private static readonly BRIGHTNESS_EPSILON = 0.015;

	bind(store: SessionStore, port: number): void {
		this.store = store;
		this.port = port;
		store.on("change", () => {
			this.lastBrightness.clear(); // force repaint after a real state change
			void this.renderAll();
		});
		// `setImage` doesn't play animated GIFs on Stream Deck (we verified),
		// so we drive the pulse by repainting tiles at 20fps. Skip-frame
		// dedup below keeps the RPC traffic low when colors aren't moving.
		setInterval(() => this.animationTick(), ANIM_TICK_MS);
		// Slow tick so the (Xm) idle hint on `done` tiles stays current
		// without burning frames on static states.
		setInterval(() => void this.renderAll(), 30_000);
	}

	override async onWillAppear(_ev: WillAppearEvent<Settings>): Promise<void> {
		this.lastBrightness.clear();
		await this.renderAll();
	}

	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		const slotIdx = this.slotIndexOf(ev.action.id);
		if (slotIdx < 0) return;
		const session = this.store?.visible()[slotIdx];
		if (!session) {
			await ev.action.showAlert();
			return;
		}
		try {
			await focusSession(session);
		} catch (err) {
			streamDeck.logger.warn("focus failed", err);
			await ev.action.showAlert();
		}
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> {
		const payload = ev.payload as { event?: string } | null;
		const event = payload?.event;
		if (!event) return;

		if (event === "getHookStatus") {
			await this.replyStatus();
			return;
		}
		if (event === "installHooks") {
			if (this.busy) return;
			this.busy = true;
			try {
				await installHooks(this.port, streamDeck.logger);
				await this.replyStatus();
				await this.renderAll();
			} catch (err) {
				await this.replyStatus(String((err as Error)?.message ?? err));
			} finally {
				this.busy = false;
			}
			return;
		}
		if (event === "uninstallHooks") {
			if (this.busy) return;
			this.busy = true;
			try {
				await uninstallHooks(streamDeck.logger);
				await this.replyStatus();
				await this.renderAll();
			} catch (err) {
				await this.replyStatus(String((err as Error)?.message ?? err));
			} finally {
				this.busy = false;
			}
			return;
		}
	}

	private async replyStatus(error?: string): Promise<void> {
		const installed = await isInstalled();
		streamDeck.ui.current?.sendToPropertyInspector({
			event: "hookStatus",
			installed,
			port: this.port,
			error,
		});
	}

	/** Our session-action instances on physical keys, sorted by physical
	 *  layout: device, row, column. */
	private orderedSlots() {
		const out: { id: string; key: string; setImage: (s: string) => Promise<void>; setTitle: (s: string) => Promise<void> }[] = [];
		for (const a of streamDeck.actions) {
			if (a.manifestId !== "com.virtuis.claudecode.session") continue;
			if (!a.isKey()) continue;
			const coords = a.coordinates;
			const device = (a.device?.id ?? "").toString();
			const row = coords?.row ?? 99;
			const col = coords?.column ?? 99;
			const key = `${device}\t${String(row).padStart(3, "0")}\t${String(col).padStart(3, "0")}`;
			out.push({
				id: a.id,
				key,
				setImage: (s) => a.setImage(s),
				setTitle: (s) => a.setTitle(s),
			});
		}
		out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
		return out;
	}

	private slotIndexOf(actionId: string): number {
		return this.orderedSlots().findIndex((s) => s.id === actionId);
	}

	/** Periodic repaint for animating tiles.
	 *  - Tiles with a scrolling caption MUST redraw every tick or the marquee
	 *    freezes whenever brightness plateaus near a peak/valley.
	 *  - Tiles with a static caption only redraw when brightness has moved
	 *    enough to be visible, saving setImage traffic. */
	private animationTick(): void {
		if (!this.store) return;
		this.animPhase = (this.animPhase + 1) >>> 0;
		const slots = this.orderedSlots();
		const sessions = this.store.visible();
		for (let i = 0; i < slots.length; i++) {
			const s = sessions[i];
			if (!s || !shouldAnimate(s.state)) continue;
			const slot = slots[i];
			const brightness = brightnessFor(s.state, this.animPhase);
			if (!captionWillScroll(s)) {
				const last = this.lastBrightness.get(slot.id);
				if (last !== undefined && Math.abs(last - brightness) < SessionAction.BRIGHTNESS_EPSILON) {
					continue;
				}
			}
			this.lastBrightness.set(slot.id, brightness);
			const { image } = renderSession(s, this.animPhase);
			void slot.setImage(image);
		}
	}

	private async renderAll(): Promise<void> {
		if (!this.store) return;
		const hooksOk = await isInstalled();
		const slots = this.orderedSlots();
		const sessions = this.store.list();
		await Promise.all(
			slots.map(async (slot, i) => {
				const s = sessions[i];
				if (s) {
					const { image } = renderSession(s, this.animPhase);
					this.lastBrightness.set(slot.id, brightnessFor(s.state, this.animPhase));
					await slot.setImage(image);
					await slot.setTitle("");
				} else {
					this.lastBrightness.delete(slot.id);
					await slot.setImage(renderEmpty(!hooksOk));
					await slot.setTitle("");
				}
			}),
		);
	}
}
