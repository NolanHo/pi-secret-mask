import type { SecretArtifactStore } from "./artifacts.js";
import { secretReference } from "./artifacts.js";

const SECRET_REF_PATTERN = /\$\{secret:(psm_mask_[a-f0-9]{24})\}/g;

export interface InjectedSecret {
	id: string;
	value: string;
	reference: string;
}

export interface InjectionResult<T> {
	value: T;
	secrets: InjectedSecret[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function injectSecretReferences<T>(value: T, store: SecretArtifactStore): InjectionResult<T> {
	const secrets: InjectedSecret[] = [];
	const seen = new Map<string, string>();

	const visit = (current: unknown): unknown => {
		if (typeof current === "string") {
			return current.replace(SECRET_REF_PATTERN, (_raw, id: string) => {
				let secret = seen.get(id);
				if (!secret) {
					secret = store.readSecret(id);
					seen.set(id, secret);
					secrets.push({ id, value: secret, reference: secretReference(id) });
				}
				return secret;
			});
		}
		if (Array.isArray(current)) return current.map(visit);
		if (isRecord(current)) return Object.fromEntries(Object.entries(current).map(([k, v]) => [k, visit(v)]));
		return current;
	};

	return { value: visit(value) as T, secrets };
}

export function redactInjectedSecrets<T>(value: T, secrets: InjectedSecret[]): T {
	if (secrets.length === 0) return value;

	const replaceSecret = (text: string): string => {
		let next = text;
		for (const secret of secrets) {
			if (!secret.value) continue;
			next = next.split(secret.value).join(`[secret_ref id=${secret.id} redacted]`);
		}
		return next;
	};

	const visit = (current: unknown): unknown => {
		if (typeof current === "string") return replaceSecret(current);
		if (Array.isArray(current)) return current.map(visit);
		if (isRecord(current)) return Object.fromEntries(Object.entries(current).map(([k, v]) => [k, visit(v)]));
		return current;
	};

	return visit(value) as T;
}

export function replaceRecordContents(target: Record<string, unknown>, source: unknown): void {
	if (!isRecord(source) || Array.isArray(source)) {
		throw new Error("Tool input secret injection expected an object root.");
	}
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, source);
}

export function containsInjectedSecret(value: unknown, secrets: InjectedSecret[]): boolean {
	if (secrets.length === 0) return false;
	if (typeof value === "string") return secrets.some((secret) => secret.value !== "" && value.includes(secret.value));
	if (Array.isArray(value)) return value.some((item) => containsInjectedSecret(item, secrets));
	if (isRecord(value)) return Object.values(value).some((item) => containsInjectedSecret(item, secrets));
	return false;
}
