/** Build-time hooks of the Commerce frontend: the `data-product-grid` page-builder marker. */
import { getEmDashCollection } from "../../lib/emdash";
import { productCardHtml } from "./cards";

const MARKER = (name: string) => new RegExp(`<([a-z][a-z0-9-]*)([^>]*\\b${name}\\b[^>]*)>\\s*</\\1>`, "g");

export async function fillSlots(html: string): Promise<string> {
	if (!/data-product-grid\b/.test(html)) return html;
	const { entries } = await getEmDashCollection("products");
	const featured = entries.filter((p) => p.data.fields.featured);
	const rest = entries.filter((p) => !p.data.fields.featured);
	return html.replace(MARKER("data-product-grid"), (_m, tag, attrs) => `<${tag}${attrs}>${[...featured, ...rest].map(productCardHtml).join("")}</${tag}>`);
}
