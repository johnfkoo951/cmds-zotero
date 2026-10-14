import type CMDSZoteroPlugin from "../main";
import { showDoctor } from "./doctor";

/** 0.6.1 library-integration commands (WP10), registered after the 0.6.0 commands. */
export function registerLibraryCommands(plugin: CMDSZoteroPlugin): void {
	plugin.addCommand({ id: "diagnose-setup", name: "Diagnose setup", callback: () => { void showDoctor(plugin); } });
}
