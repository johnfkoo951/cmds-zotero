/**
 * Zotero libraries and collections in the index (0.6 collection-membership-index): the collection tree `user.groups(true)`
 * reports, "Parent/Child" paths, direct membership, and forward-compatible readers of the additive index fields.
 * Pure module: no `obsidian` import, so `tsx --test` and the offline core can load it.
 */
import type { IndexCollection, IndexLibrary, ZoteroIndex } from "../types";

export interface CollectionNode { libraryID: number; key: string; name: string; parentKey: string | null }

const COLLECTION_KEY = /^[A-Z0-9]{8}$/;
const LIBRARY_KINDS = new Set<string>(["user", "group", "feed", "unknown"]);

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Stable identifier of a collection across libraries: `<libraryID>:<collectionKey>`. */
export function collectionId(libraryID: number, key: string): string { return `${libraryID}:${key}`; }

/**
 * One library's flat collection list as `user.groups(true)` reports it: `{key, name, parentCollection: key | false}` per
 * collection, nested ones included. Rows that are malformed or in Zotero's trash (`deleted: true`) are left out; a
 * repeated key keeps its first row.
 */
export function parseCollections(libraryID: number, raw: unknown): CollectionNode[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const nodes: CollectionNode[] = [];
	for (const row of raw) {
		if (!record(row) || typeof row.key !== "string" || !COLLECTION_KEY.test(row.key) || typeof row.name !== "string" || row.deleted === true || seen.has(row.key)) continue;
		const parent = typeof row.parentCollection === "string" && COLLECTION_KEY.test(row.parentCollection) && row.parentCollection !== row.key ? row.parentCollection : null;
		seen.add(row.key);
		nodes.push({ libraryID, key: row.key, name: row.name, parentKey: parent });
	}
	return nodes;
}

/**
 * "Parent/Child" path of every collection, keyed by `collectionId`. A parent that is not listed (trashed or missing) makes
 * its child a root; a parent loop stops at the first collection seen twice, so corrupt data never recurses forever.
 */
export function collectionPaths(nodes: readonly CollectionNode[]): Map<string, string> {
	const byId = new Map(nodes.map(node => [collectionId(node.libraryID, node.key), node]));
	const paths = new Map<string, string>();
	const pathOf = (node: CollectionNode): string => {
		const id = collectionId(node.libraryID, node.key);
		const known = paths.get(id);
		if (known !== undefined) return known;
		const chain: CollectionNode[] = [];
		const visited = new Set<string>();
		let current: CollectionNode | undefined = node;
		let prefix = "";
		while (current) {
			const currentId = collectionId(current.libraryID, current.key);
			if (visited.has(currentId)) break;
			const cached = paths.get(currentId);
			if (cached !== undefined) { prefix = cached; break; }
			visited.add(currentId);
			chain.push(current);
			current = current.parentKey ? byId.get(collectionId(current.libraryID, current.parentKey)) : undefined;
		}
		for (let index = chain.length - 1; index >= 0; index--) {
			prefix = prefix ? `${prefix}/${chain[index].name}` : chain[index].name;
			paths.set(collectionId(chain[index].libraryID, chain[index].key), prefix);
		}
		return paths.get(id) ?? node.name;
	};
	for (const node of nodes) pathOf(node);
	return paths;
}

export interface CollectionTreeNode { collection: CollectionNode; path: string; children: CollectionTreeNode[] }

/**
 * The collection tree for display: roots and children sorted by name (locale-aware), cycle-safe (a collection inside a
 * parent loop is shown as a root once). Each node carries its path.
 */
export function collectionTree(nodes: readonly CollectionNode[]): CollectionTreeNode[] {
	const paths = collectionPaths(nodes);
	const byId = new Map(nodes.map(node => [collectionId(node.libraryID, node.key), node]));
	const treeNodes = new Map(nodes.map(node => [collectionId(node.libraryID, node.key), { collection: node, path: paths.get(collectionId(node.libraryID, node.key)) ?? node.name, children: [] as CollectionTreeNode[] }]));
	const roots: CollectionTreeNode[] = [];
	for (const node of nodes) {
		const tree = treeNodes.get(collectionId(node.libraryID, node.key));
		if (!tree) continue;
		const parent = node.parentKey ? treeNodes.get(collectionId(node.libraryID, node.parentKey)) : undefined;
		// A collection whose parent chain leads back to itself is shown at the root instead.
		if (parent && !inLoop(node, byId)) parent.children.push(tree);
		else roots.push(tree);
	}
	const sort = (list: CollectionTreeNode[]): CollectionTreeNode[] => {
		list.sort((left, right) => left.collection.name.localeCompare(right.collection.name) || byCodeUnit(left.collection.key, right.collection.key));
		for (const item of list) sort(item.children);
		return list;
	};
	return sort(roots);
}

/** True when following parent links from `node` comes back to `node` itself. */
function inLoop(node: CollectionNode, byId: ReadonlyMap<string, CollectionNode>): boolean {
	const seen = new Set<string>();
	let current = node.parentKey ? byId.get(collectionId(node.libraryID, node.parentKey)) : undefined;
	while (current) {
		if (current.key === node.key) return true;
		if (seen.has(current.key)) return false;
		seen.add(current.key);
		current = current.parentKey ? byId.get(collectionId(current.libraryID, current.parentKey)) : undefined;
	}
	return false;
}

/** Code-unit order, so stored values (and entry hashes) do not depend on the runtime's locale. */
function byCodeUnit(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

/**
 * The sorted, de-duplicated collection paths of every entry, from direct membership (`collectionId` → entry ids). This is
 * what an entry's `collections` field stores.
 */
export function entryCollectionPaths(nodes: readonly CollectionNode[], members: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
	const paths = collectionPaths(nodes);
	const byEntry = new Map<string, Set<string>>();
	for (const [id, entries] of members) {
		const path = paths.get(id);
		if (path === undefined) continue;
		for (const entry of entries) {
			const set = byEntry.get(entry) ?? new Set<string>();
			set.add(path);
			byEntry.set(entry, set);
		}
	}
	return new Map([...byEntry].map(([entry, set]) => [entry, [...set].sort(byCodeUnit)]));
}

/** The index's libraries, skipping malformed elements (forward compatible: unknown fields are ignored). */
export function indexLibraries(index: Pick<ZoteroIndex, "libraries"> | null | undefined): IndexLibrary[] {
	const raw: unknown = index?.libraries;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item: unknown): IndexLibrary[] => {
		if (!record(item) || !positive(item.libraryID) || typeof item.name !== "string") return [];
		const kind = typeof item.kind === "string" && LIBRARY_KINDS.has(item.kind) ? item.kind as IndexLibrary["kind"] : "unknown";
		return [{ libraryID: item.libraryID, name: item.name, kind, ...(positive(item.groupID) ? { groupID: item.groupID } : {}), items: typeof item.items === "number" && Number.isSafeInteger(item.items) && item.items >= 0 ? item.items : 0, indexed: typeof item.indexed === "number" && Number.isSafeInteger(item.indexed) && item.indexed >= 0 ? item.indexed : 0 }];
	});
}

/** The library's name as Zotero shows it ("My Library", a group name), or null when the index does not list it. */
export function libraryName(index: Pick<ZoteroIndex, "libraries"> | null | undefined, libraryID: number): string | null {
	return indexLibraries(index).find(library => library.libraryID === libraryID)?.name ?? null;
}

/** The index's collections, skipping malformed elements; `items` stays absent when membership was not read. */
export function indexCollections(index: Pick<ZoteroIndex, "collections"> | null | undefined): IndexCollection[] {
	const raw: unknown = index?.collections;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item: unknown): IndexCollection[] => {
		if (!record(item) || !positive(item.libraryID) || typeof item.key !== "string" || !COLLECTION_KEY.test(item.key) || typeof item.name !== "string") return [];
		const parentKey = typeof item.parentKey === "string" && COLLECTION_KEY.test(item.parentKey) ? item.parentKey : null;
		const items = Array.isArray(item.items) ? item.items.filter((id: unknown): id is string => typeof id === "string") : undefined;
		return [{ libraryID: item.libraryID, key: item.key, name: item.name, parentKey, ...(items ? { items } : {}) }];
	});
}

export interface EntryCollection { libraryID: number; key: string; name: string; path: string }

/** Collections an index entry is filed in directly, sorted by path; empty when membership is unknown. */
export function collectionsOfEntry(index: Pick<ZoteroIndex, "collections"> | null | undefined, entryId: string): EntryCollection[] {
	const collections = indexCollections(index);
	const paths = collectionPaths(collections);
	return collections.filter(collection => collection.items?.includes(entryId)).map(collection => ({ libraryID: collection.libraryID, key: collection.key, name: collection.name, path: paths.get(collectionId(collection.libraryID, collection.key)) ?? collection.name })).sort((left, right) => byCodeUnit(left.path, right.path));
}

/**
 * Entry ids filed in one collection; with `recursive`, members of its subcollections too (each id once). Null when the
 * collection is unknown or its membership (or a subcollection's) was not read.
 */
export function membersOf(index: Pick<ZoteroIndex, "collections"> | null | undefined, libraryID: number, key: string, options: { recursive?: boolean } = {}): string[] | null {
	const collections = indexCollections(index).filter(collection => collection.libraryID === libraryID);
	const byKey = new Map(collections.map(collection => [collection.key, collection]));
	const start = byKey.get(key);
	if (!start) return null;
	const children = new Map<string, IndexCollection[]>();
	for (const collection of collections) if (collection.parentKey) children.set(collection.parentKey, [...(children.get(collection.parentKey) ?? []), collection]);
	const members = new Set<string>();
	const visited = new Set<string>();
	const queue = [start];
	while (queue.length) {
		const current = queue.shift() as IndexCollection;
		if (visited.has(current.key)) continue;
		visited.add(current.key);
		if (!current.items) return null;
		for (const id of current.items) members.add(id);
		if (options.recursive) queue.push(...(children.get(current.key) ?? []));
	}
	return [...members];
}
