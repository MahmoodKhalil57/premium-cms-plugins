/** Platform frontend: sign-up / sign-in, the customer dashboard and pricing on the PremiumCMS site itself. */
import "./styles.css";
import { initPlatform } from "./platform";

if (typeof document !== "undefined") {
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initPlatform);
	else initPlatform();
}
