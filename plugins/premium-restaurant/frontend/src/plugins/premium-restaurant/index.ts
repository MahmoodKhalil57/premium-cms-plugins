/** Restaurant frontend: menu + QR ordering, tracking, reservations, the staff app, and the checkout step. */
import "./styles.css";
import "./checkout";
import { initRestaurant } from "./menu";
import { initStaffApp } from "./staff";

if (typeof document !== "undefined") {
	const boot = () => {
		initRestaurant();
		initStaffApp();
	};
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
	else boot();
}
