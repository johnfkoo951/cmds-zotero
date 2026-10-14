**English** | [한국어](zotero-side.ko.md)

# Opening notes from Zotero

CMDS Zotero does not install anything into Zotero. To open a literature note, or its import preview, from inside Zotero you add one script to [Actions & Tags](https://github.com/windingwind/zotero-actions-tags), a Zotero add-on you install and control yourself. The script only launches an `obsidian://cmds-zotero` link, the same link the plugin already accepts; it does not change your Zotero library.

## Requirements

- Zotero 10.0.3 or later. Zotero 10.0.2 could not launch `obsidian://` links.
- Actions & Tags 2.6 or later, installed in Zotero.
- Better BibTeX and a refreshed citekey index in Obsidian, as for every other command.

## Copy the script

1. In Obsidian, run **Copy Zotero action script**.
2. Choose what the action should do:
   - **Open literature note** opens the item's note in this vault, or says that none exists yet.
   - **Preview literature import** opens the import preview for the item. Nothing is written until you confirm.
3. The script is now on the clipboard, with this vault's name in it. Copy it again from another vault if you want an action for that vault too.

## Add the action in Zotero

1. Open Zotero's settings and go to **Actions & Tags**.
2. Add an action. Leave the event empty for a menu or shortcut action, set the operation to **Custom script**, and paste the script as its data.
3. Give it a menu label such as "Open in Obsidian" and show it in the item menu, the reader menu or both. Add a shortcut if you like.
4. Optional: to open the note whenever a PDF is opened, add a second action with the **Open file** event and the same script.

The action works on one item. Selecting an attachment, a child note or an annotation counts as its parent item. With several items selected it launches nothing and tells you to use **Open Zotero selection** or **Import Zotero selection** in Obsidian, which list the selected items to pick from.

## The confirmation prompt

The first time, Zotero asks whether it may open `obsidian://` links with Obsidian. Allow it. If Zotero keeps asking, the per-protocol preferences `network.protocol-handler.external.obsidian` and `network.protocol-handler.warn-external.obsidian` in Zotero's Config Editor control the prompt; the steps differ between Zotero versions. CMDS Zotero never changes these preferences for you.

## What the link contains

```
obsidian://cmds-zotero?vault=<vault>&libraryID=<library ID>&itemKey=<item key>&target=note|import
```

`libraryID` is Zotero's local library ID and `itemKey` the item's eight-character key. Obsidian matches them against the saved index, never by title or first search match. If the item is not in the index yet, Obsidian says so: refresh the citekey index and retry.

## Not covered

- Opening the PDF in Obsidian. A `target=pdf` link opens the PDF in Zotero, so the script does not offer it.
- One-click installation, native Zotero menus that show whether a note exists, and an "Obsidian note" column. These need a Zotero add-on or a local server, which this plugin does not ship.
