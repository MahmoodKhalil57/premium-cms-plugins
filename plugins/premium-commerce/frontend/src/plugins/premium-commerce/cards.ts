/** Product card HTML — one source for the ProductCard component and the `data-product-grid` page-builder marker. */
import type { Entry, MediaValue } from "../../lib/emdash";
import { imageHtml } from "../../lib/cards";
import { esc } from "../../lib/pt";
import { formatPrice, STORE_CURRENCY } from "./money";

export function productCardHtml(product: Entry): string {
	const f = product.data.fields;
	const img = imageHtml((f.image as MediaValue | null) ?? null);
	const price = formatPrice(f.price as number, STORE_CURRENCY);
	const compare = f.compare_at_price ? `<s>${esc(formatPrice(f.compare_at_price as number, STORE_CURRENCY))}</s>` : "";
	const hasSizes = typeof f.sizes === "string" ? f.sizes.trim().length > 0 : Array.isArray(f.sizes) && f.sizes.length > 0;
	// Sized products are chosen on their page (size picker); everything else adds straight from the card.
	const action = hasSizes
		? `<a class="ec-add-to-cart ec-add-to-cart--link" href="/products/${esc(product.id)}">Choose size</a>`
		: `<button type="button" class="ec-add-to-cart" data-add-to-cart="${esc(product.id)}" data-product-id="${esc(product.data.id)}" data-title="${esc(product.data.title ?? "")}" data-price="${esc(String(f.price ?? ""))}" data-slug="${esc(product.id)}">Add to cart</button>`;
	return `<article class="ec-product-card" data-product="${esc(product.data.id)}"><a href="/products/${esc(product.id)}" class="ec-product-card__media">${img || `<div class="ec-product-card__placeholder" aria-hidden="true"></div>`}</a><div class="ec-product-card__body"><h3 class="ec-product-card__title"><a href="/products/${esc(product.id)}">${esc(product.data.title ?? "")}</a></h3><p class="ec-product-card__price"><span>${esc(price)}</span>${compare}</p><p class="ec-product-card__stock" data-availability="${esc(product.data.id)}" hidden></p>${action}</div></article>`;
}
