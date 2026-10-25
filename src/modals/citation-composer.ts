import { App, Modal, Setting } from "obsidian";
import { composeCluster, type ComposedCitationItem } from "../citations/cluster";
import { rankCompletions } from "../citations/score";
import { indexDerived } from "../index-derived";
import { matchesQuery, queryContext, rankingQuery } from "../search/query";
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";

interface ImeEvent { isComposing?: boolean; keyCode?: number }

const isImeComposing = (event: KeyboardEvent): boolean => Boolean(event.isComposing || (event as ImeEvent).keyCode === 229);

/**
 * Multi-item pandoc citation cluster composer: add/remove/reorder sources, edit per-item prefix, locator, suffix and
 * author suppression (`-@key`), with live cluster preview and Korean IME composition guards.
 */
export class CitationComposerModal extends Modal {
	private items: ComposedCitationItem[];
	private query = "";
	private previewEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private resultsEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly entries: readonly ZoteroIndexEntry[],
		initial: readonly ComposedCitationItem[],
		private readonly onSubmit: (text: string, items: ComposedCitationItem[]) => void,
		private readonly index: ZoteroIndex | null = null,
	) {
		super(app);
		this.items = initial.map(item => ({
			citekey: item.citekey,
			prefix: item.prefix ?? "",
			locator: item.locator ?? "",
			suffix: item.suffix ?? "",
			suppressAuthor: Boolean(item.suppressAuthor),
		}));
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		new Setting(contentEl).setName("Compose citation cluster").setHeading();

		const previewSetting = new Setting(contentEl).setName("Preview").setDesc("Pandoc citation cluster to insert.");
		this.previewEl = previewSetting.controlEl.createEl("code", { cls: "cmds-zotero-composer-preview" });
		this.updatePreview();

		const searchSetting = new Setting(contentEl).setName("Add source").setDesc("Search the literature index by citekey, title, author or year (enter adds the top match).");
		searchSetting.addText(text => {
			text.setPlaceholder("Search literature…");
			const updateSearch = (): void => {
				this.query = text.inputEl.value;
				this.renderResults();
			};
			// Korean IME: update search results during composition (`input`) and again on `compositionend`.
			text.inputEl.addEventListener("input", updateSearch);
			text.inputEl.addEventListener("compositionend", updateSearch);
			text.inputEl.addEventListener("keydown", event => {
				if (event.key !== "Enter") return;
				if (isImeComposing(event)) return;
				event.preventDefault();
				const matches = this.matchingEntries();
				if (matches.length) {
					this.addEntry(matches[0].citekey);
					text.setValue("");
					this.query = "";
					this.renderResults();
				} else if (this.items.length) {
					this.submit();
				}
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});

		this.resultsEl = contentEl.createDiv({ cls: "cmds-zotero-composer-results" });
		this.renderResults();

		new Setting(contentEl).setName("Cluster items").setHeading();
		this.listEl = contentEl.createDiv({ cls: "cmds-zotero-composer-items" });
		this.renderItems();

		new Setting(contentEl)
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => button.setButtonText("Insert citation").setCta().onClick(() => this.submit()));
	}

	private matchingEntries(): ZoteroIndexEntry[] {
		const trimmed = this.query.trim();
		if (!trimmed) return [];
		const rows = indexDerived(this.entries).completionRows;
		const plan = rankingQuery(trimmed);
		const filtered = plan.fielded && plan.terms.length
			? rows.filter(row => matchesQuery(row.entry, plan.terms, queryContext(this.index)))
			: rows;
		return rankCompletions(filtered, plan.fielded ? plan.text : trimmed).slice(0, 8);
	}

	private renderResults(): void {
		const container = this.resultsEl;
		if (!container) return;
		container.empty();
		const matches = this.matchingEntries();
		for (const entry of matches) {
			const row = new Setting(container)
				.setName(`${entry.title || entry.citekey} (${entry.year || "n.d."})`)
				.setDesc(`@${entry.citekey}${entry.authors.length ? ` · ${entry.authors.slice(0, 2).join("; ")}` : ""}`);
			row.addButton(button => button.setButtonText("Add").onClick(() => {
				this.addEntry(entry.citekey);
			}));
		}
	}

	addEntry(citekey: string): void {
		if (!citekey.trim()) return;
		this.items.push({ citekey: citekey.trim(), prefix: "", locator: "", suffix: "", suppressAuthor: false });
		this.renderItems();
		this.updatePreview();
	}

	private renderItems(): void {
		const container = this.listEl;
		if (!container) return;
		container.empty();
		if (!this.items.length) {
			container.createDiv({ cls: "setting-item-description", text: "No sources in this cluster yet. Search above to add one." });
			return;
		}
		this.items.forEach((item, index) => {
			const block = container.createDiv({ cls: "cmds-zotero-composer-item" });
			const header = new Setting(block).setName(`@${item.citekey}`);
			header.addToggle(toggle => toggle
				.setTooltip("Suppress author (-@key)")
				.setValue(Boolean(item.suppressAuthor))
				.onChange(value => {
					item.suppressAuthor = value;
					this.updatePreview();
				}));
			header.addExtraButton(button => button
				.setIcon("arrow-up")
				.setTooltip("Move up")
				.setDisabled(index === 0)
				.onClick(() => {
					if (index <= 0) return;
					const [moved] = this.items.splice(index, 1);
					this.items.splice(index - 1, 0, moved);
					this.renderItems();
					this.updatePreview();
				}));
			header.addExtraButton(button => button
				.setIcon("arrow-down")
				.setTooltip("Move down")
				.setDisabled(index === this.items.length - 1)
				.onClick(() => {
					if (index >= this.items.length - 1) return;
					const [moved] = this.items.splice(index, 1);
					this.items.splice(index + 1, 0, moved);
					this.renderItems();
					this.updatePreview();
				}));
			header.addExtraButton(button => button
				.setIcon("trash")
				.setTooltip("Remove")
				.onClick(() => {
					this.items.splice(index, 1);
					this.renderItems();
					this.updatePreview();
				}));

			const bindField = (setting: Setting, placeholder: string, current: string, assign: (next: string) => void): void => {
				setting.addText(text => {
					text.setPlaceholder(placeholder).setValue(current).onChange(next => {
						assign(next);
						this.updatePreview();
					});
					text.inputEl.addEventListener("compositionend", () => {
						assign(text.inputEl.value);
						this.updatePreview();
					});
					text.inputEl.addEventListener("keydown", event => {
						if (event.key !== "Enter" || isImeComposing(event)) return;
						event.preventDefault();
						this.submit();
					});
				});
			};

			const fields = new Setting(block).setName("Prefix / locator / suffix");
			bindField(fields, "Prefix (e.g. see)", item.prefix ?? "", next => { item.prefix = next; });
			bindField(fields, "Locator (e.g. p. 3)", item.locator ?? "", next => { item.locator = next; });
			bindField(fields, "Suffix (e.g. emphasis added)", item.suffix ?? "", next => { item.suffix = next; });
		});
	}

	private updatePreview(): void {
		if (!this.previewEl) return;
		this.previewEl.setText(composeCluster(this.items) || "[@citekey]");
	}

	submit(): void {
		const text = composeCluster(this.items);
		this.close();
		if (text) this.onSubmit(text, [...this.items]);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
