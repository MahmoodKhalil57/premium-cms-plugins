/** Settings subset the PSP helpers need (kept separate so customers.ts has no settings import cycle). */
export interface ProviderEnv {
	stripeSecretKey: string;
	polarAccessToken: string;
	polarProductId: string;
}
