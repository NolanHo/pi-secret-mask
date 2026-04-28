import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionEntry, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import type { SecretArtifactStore } from "./artifacts.js";
import { secretPatterns } from "./patterns.js";
import type { SecretPattern } from "./patterns.js";

export interface ProjectionResult<T> {
	value: T;
	maskCount: number;
}

type TextBlock = {
	type: "text";
	text: string;
	[key: string]: unknown;
};

type ContentCarrier = {
	content?: unknown;
	[key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTextBlock(value: unknown): value is TextBlock {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isInsideSecretMarker(text: string, index: number): boolean {
	const start = text.lastIndexOf("[secret_ref", index);
	if (start === -1) return false;
	const end = text.indexOf("]", start);
	return end !== -1 && index <= end;
}

function replaceWithExec(text: string, pattern: RegExp, replacer: (match: RegExpExecArray) => string): string {
	pattern.lastIndex = 0;
	let result = "";
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		result += text.slice(lastIndex, match.index);
		result += isInsideSecretMarker(text, match.index) ? match[0] : replacer(match);
		lastIndex = match.index + match[0].length;
		if (match[0].length === 0) pattern.lastIndex += 1;
	}
	return result + text.slice(lastIndex);
}

export function projectText(
	text: string,
	sourcePath: string,
	store: SecretArtifactStore,
	patterns: SecretPattern[] = secretPatterns,
): ProjectionResult<string> {
	let next = text;
	let maskCount = 0;
	for (const spec of patterns) {
		next = replaceWithExec(next, spec.pattern, (match) => {
			const secret = spec.secret(match);
			const artifact = store.putSecret({ content: secret, sourcePath, pattern: spec.name });
			maskCount += 1;
			return spec.replace(match, artifact.id);
		});
	}
	return { value: next, maskCount };
}

export function projectMessage<T extends AgentMessage>(
	message: T,
	sourcePath: string,
	store: SecretArtifactStore,
	patterns: SecretPattern[] = secretPatterns,
): ProjectionResult<T> {
	const carrier = message as ContentCarrier;
	const content = carrier.content;
	let maskCount = 0;
	let nextContent: unknown = content;

	if (typeof content === "string") {
		const projected = projectText(content, `${sourcePath}.content`, store, patterns);
		maskCount += projected.maskCount;
		nextContent = projected.value;
	} else if (Array.isArray(content)) {
		nextContent = content.map((block, i) => {
			if (!isTextBlock(block)) return block;
			const projected = projectText(block.text, `${sourcePath}.content.${i}.text`, store, patterns);
			maskCount += projected.maskCount;
			return projected.maskCount === 0 ? block : { ...block, text: projected.value };
		});
	}

	if (maskCount === 0) return { value: message, maskCount };
	return { value: { ...(message as Record<string, unknown>), content: nextContent } as T, maskCount };
}

export function projectMessages<T extends AgentMessage>(
	messages: T[],
	store: SecretArtifactStore,
	sourcePath: string,
	patterns: SecretPattern[] = secretPatterns,
): ProjectionResult<T[]> {
	let maskCount = 0;
	const value = messages.map((message, i) => {
		const projected = projectMessage(message, `${sourcePath}.${i}`, store, patterns);
		maskCount += projected.maskCount;
		return projected.value;
	});
	return { value, maskCount };
}

export function projectSessionEntries<T extends SessionEntry>(
	entries: T[],
	store: SecretArtifactStore,
	sourcePath: string,
	patterns: SecretPattern[] = secretPatterns,
): ProjectionResult<T[]> {
	let maskCount = 0;
	const value = entries.map((entry, i) => {
		if (entry.type !== "message") return entry;
		const messageEntry = entry as unknown as SessionMessageEntry;
		const projected = projectMessage(messageEntry.message, `${sourcePath}.${i}.message`, store, patterns);
		maskCount += projected.maskCount;
		return projected.maskCount === 0 ? entry : ({ ...messageEntry, message: projected.value } as unknown as T);
	});
	return { value, maskCount };
}

export function projectUnknownStrings(
	value: unknown,
	store: SecretArtifactStore,
	sourcePath: string,
	patterns: SecretPattern[] = secretPatterns,
): ProjectionResult<unknown> {
	if (typeof value === "string") return projectText(value, sourcePath, store, patterns);
	if (Array.isArray(value)) {
		let maskCount = 0;
		const projected = value.map((item, i) => {
			const result = projectUnknownStrings(item, store, `${sourcePath}.${i}`, patterns);
			maskCount += result.maskCount;
			return result.value;
		});
		return { value: projected, maskCount };
	}
	if (isRecord(value)) {
		let maskCount = 0;
		const entries = Object.entries(value).map(([key, item]) => {
			const result = projectUnknownStrings(item, store, `${sourcePath}.${key}`, patterns);
			maskCount += result.maskCount;
			return [key, result.value] as const;
		});
		return { value: Object.fromEntries(entries), maskCount };
	}
	return { value, maskCount: 0 };
}
