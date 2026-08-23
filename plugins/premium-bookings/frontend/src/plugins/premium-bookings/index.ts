/** Bookings frontend: the [data-booking] widget (pays through the Commerce checkout). */
import "./styles.css";
import { initBooking } from "./booking";

if (typeof document !== "undefined") {
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initBooking);
	else initBooking();
}
