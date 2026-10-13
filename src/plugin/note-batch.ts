import { App, Notice, TAbstractFile, TFolder, type EventRef } from "obsidian";
import type { IdentityMap } from "../batch/identity-map";

/**
 * One literature-note batch in the UI (0.6 batch-performance-progress): a progress Notice with a Cancel button, and the
 * batch's identity map, kept current by vault events while the batch runs (the batch's own writes update it directly).
 * Cancel only raises a flag; the batch stops before its next note, never during a write. Call `close()` when done.
 */
export class NoteBatch {
	private readonly notice: Notice;
	private readonly message: HTMLElement;
	private readonly detail: HTMLElement;
	private readonly button: HTMLButtonElement;
	private readonly refs: EventRef[];
	private cancelRequested = false;

	constructor(private readonly app: App, readonly identities: IdentityMap, message: string) {
		const fragment = createFragment();
		const body = fragment.createDiv({ cls: "cmds-zotero-batch-progress" });
		this.message = body.createDiv({ text: message });
		this.detail = body.createDiv({ cls: "cmds-zotero-batch-progress-detail" });
		this.button = body.createEl("button", { text: "Cancel", attr: { "aria-label": "Stop after the current note" } });
		// A click on a Notice dismisses it; the button keeps the Notice so it can show that the batch is stopping.
		this.button.addEventListener("click", event => { event.stopPropagation(); this.cancel(); });
		this.notice = new Notice(fragment, 0);
		const vault = app.vault;
		const changed = (file: TAbstractFile, oldPath?: string): void => {
			if (file instanceof TFolder) { identities.foldersChanged(); return; }
			identities.noteChanged(file.path);
			if (oldPath !== undefined) identities.noteChanged(oldPath);
		};
		this.refs = [
			vault.on("create", file => changed(file)),
			vault.on("modify", file => changed(file)),
			vault.on("delete", file => changed(file)),
			vault.on("rename", (file, oldPath) => changed(file, oldPath)),
		];
	}

	/** True once Cancel was pressed (or `cancel()` called). */
	get cancelled(): boolean { return this.cancelRequested; }

	cancel(): void {
		if (this.cancelRequested) return;
		this.cancelRequested = true;
		this.button.disabled = true;
		this.button.setText("Stopping…");
		this.detail.setText("Stopping after the current note.");
	}

	/** The progress line and, below it, the item being processed. */
	update(message: string, detail = ""): void {
		this.message.setText(message);
		if (!this.cancelRequested) this.detail.setText(detail);
	}

	close(): void {
		for (const ref of this.refs) this.app.vault.offref(ref);
		this.notice.hide();
	}
}
