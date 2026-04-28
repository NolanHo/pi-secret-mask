import { secretReference } from "./artifacts.js";

export interface SecretPattern {
	name: string;
	description: string;
	pattern: RegExp;
	secret(match: RegExpExecArray): string;
	replace(match: RegExpExecArray, artifactId: string): string;
}

export function secretMarker(id: string, label: string, chars: number): string {
	return `[secret_ref id=${id} label=${label} chars=${chars}. Use ${secretReference(id)} in tool arguments to use this secret without reading it.]`;
}

export const secretPatterns: SecretPattern[] = [
	{
		name: "private-key-block",
		description: "PEM private key blocks from BEGIN ... PRIVATE KEY to END ... PRIVATE KEY.",
		pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
		secret: (m) => m[0],
		replace: (m, id) => secretMarker(id, "private key", [...m[0]].length),
	},
	{
		name: "auth-header-token",
		description: "Bearer, Basic, or Token credentials, optionally preceded by Authorization: or Authorization=.",
		pattern: /\b((?:Authorization\s*[:=]\s*)?(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+\/=:-]{16,})\b/gi,
		secret: (m) => m[2],
		replace: (m, id) => `${m[1]}${secretMarker(id, "auth token", [...m[2]].length)}`,
	},
	{
		name: "sensitive-query-param",
		description: "Sensitive URL query parameters: access_token, refresh_token, id_token, client_secret, code, code_verifier, code_challenge, state, nonce.",
		pattern: /([?&](?:access_token|refresh_token|id_token|client_secret|code|code_verifier|code_challenge|state|nonce)=)([^&#\s]{8,})/gi,
		secret: (m) => m[2],
		replace: (m, id) => `${m[1]}${secretMarker(id, "query parameter", [...m[2]].length)}`,
	},
	{
		name: "secret-assignment",
		description: "Assignments whose key name contains API_KEY, TOKEN, SECRET, PASSWORD, PASSWD, PRIVATE_KEY, CLIENT_SECRET, or AUTH.",
		pattern: /\b([A-Z0-9_.-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|AUTH)[A-Z0-9_.-]*\s*[:=]\s*["']?)([^\s"',}\[]{8,})(["']?)/gi,
		secret: (m) => m[2],
		replace: (m, id) => `${m[1]}${secretMarker(id, "secret", [...m[2]].length)}${m[3]}`,
	},
	{
		name: "json-secret-field",
		description: "Quoted JSON-like fields named api_key, access_token, refresh_token, id_token, secret, password, private_key, client_secret, or authorization.",
		pattern: /(["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|private[_-]?key|client[_-]?secret|authorization)["']\s*:\s*["'])([^"']{8,})(["'])/gi,
		secret: (m) => m[2],
		replace: (m, id) => `${m[1]}${secretMarker(id, "json secret", [...m[2]].length)}${m[3]}`,
	},
	{
		name: "known-token-prefix",
		description: "Known token prefixes: sk-, sk-ant-, sk-proj-, ghp_, gho_, ghu_, ghs_, ghr_, github_pat_, glpat-, Slack xox*/xapp-, npm_, pypi-, hf_, AIza, AKIA, ASIA.",
		pattern: /\b((?:sk-(?:ant-|proj-)?|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[baprs]-|xapp-|npm_|pypi-[A-Za-z0-9_-]*|hf_|AIza|AKIA|ASIA)[A-Za-z0-9._~+\/-]{12,})\b/g,
		secret: (m) => m[1],
		replace: (m, id) => secretMarker(id, "known token", [...m[1]].length),
	},
];
