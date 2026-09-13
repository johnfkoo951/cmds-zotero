/** Zotero reader palette. Names double as CSS class suffixes and heading selectors. */
export const ANNOTATION_COLORS = ["yellow", "red", "green", "blue", "purple", "magenta", "orange", "gray"] as const;
export type AnnotationColor = typeof ANNOTATION_COLORS[number];

const PALETTE: Record<AnnotationColor, [number, number, number]> = {
	yellow: [0xff, 0xd4, 0x00],
	red: [0xff, 0x66, 0x66],
	green: [0x5f, 0xb2, 0x36],
	blue: [0x2e, 0xa8, 0xe5],
	purple: [0xa2, 0x8a, 0xe5],
	magenta: [0xe5, 0x6e, 0xee],
	orange: [0xf1, 0x98, 0x37],
	gray: [0xaa, 0xaa, 0xaa],
};

export function parseHexColor(value: string): [number, number, number] | null {
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
	if (!match) return null;
	const hex = match[1].length === 3 ? [...match[1]].map(c => c + c).join("") : match[1];
	return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function hsl([r, g, b]: [number, number, number]): [number, number, number] {
	const red = r / 255, green = g / 255, blue = b / 255;
	const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
	const light = (max + min) / 2;
	const delta = max - min;
	if (delta === 0) return [0, 0, light];
	const saturation = delta / (1 - Math.abs(2 * light - 1));
	let hue = max === red ? ((green - blue) / delta) % 6 : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
	hue = (hue * 60 + 360) % 360;
	return [hue, saturation, light];
}

/** Nearest palette entry by hue for chromatic colors, gray for desaturated ones; empty or unparsable colors return null rather than a guess. */
export function colorName(value: string): AnnotationColor | null {
	const rgb = parseHexColor(value);
	if (!rgb) return null;
	const [hue, saturation] = hsl(rgb);
	if (saturation < 0.2) return "gray";
	let best: AnnotationColor | null = null;
	let bestDistance = Infinity;
	for (const name of ANNOTATION_COLORS) {
		if (name === "gray") continue;
		const [paletteHue] = hsl(PALETTE[name]);
		const distance = Math.min(Math.abs(hue - paletteHue), 360 - Math.abs(hue - paletteHue));
		if (distance < bestDistance) { bestDistance = distance; best = name; }
	}
	return best;
}

export function isAnnotationColor(value: string): value is AnnotationColor {
	return (ANNOTATION_COLORS as readonly string[]).includes(value);
}
