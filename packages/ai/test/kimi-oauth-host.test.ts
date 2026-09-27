import { afterEach, describe, expect, test, vi } from "bun:test";
import { refreshKimiToken } from "@oh-my-pi/pi-ai/registry/oauth/kimi";

const OVERRIDES = ["KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST"] as const;

function captureTokenUrl(): { urls: string[] } {
	const urls: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request) => {
				urls.push(input instanceof Request ? input.url : String(input));
				return Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600 });
			},
			{ preconnect: fetch.preconnect },
		),
	);
	return { urls };
}

describe("Kimi OAuth host", () => {
	const saved = new Map<string, string | undefined>();

	afterEach(() => {
		vi.restoreAllMocks();
		for (const key of OVERRIDES) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		saved.clear();
	});

	function clearOverrides(): void {
		for (const key of OVERRIDES) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
	}

	test("global accounts refresh against auth.kimi.ai by default", async () => {
		clearOverrides();
		const { urls } = captureTokenUrl();
		await refreshKimiToken("refresh-token");
		expect(urls).toEqual(["https://auth.kimi.ai/api/oauth/token"]);
	});

	test("KIMI_CODE_OAUTH_HOST still overrides the default host", async () => {
		clearOverrides();
		process.env.KIMI_CODE_OAUTH_HOST = "https://auth.kimi.com";
		const { urls } = captureTokenUrl();
		await refreshKimiToken("refresh-token");
		expect(urls).toEqual(["https://auth.kimi.com/api/oauth/token"]);
	});
});
