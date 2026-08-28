// Release runner — see wrangler.jsonc. Serves nothing.
export default {
	fetch(): Response {
		return new Response(null, { status: 204 });
	},
};
