import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { generateBranchSummary, generateSummary } from "@mariozechner/pi-coding-agent";
import { SecretArtifactStore } from "../src/artifacts.js";
import { loadConfiguredPatterns } from "../src/config.js";
import { secretPatterns } from "../src/patterns.js";
import { projectMessages, projectSessionEntries, projectText, projectUnknownStrings } from "../src/project.js";
import { containsInjectedSecret, injectSecretReferences, redactInjectedSecrets, replaceRecordContents } from "../src/secret-ref.js";
import type { InjectedSecret } from "../src/secret-ref.js";

const SYSTEM_PROMPT = `pi-secret-mask is active. Secret values in context are replaced by [secret_ref ...] markers. Do not ask to reveal them. To use a masked secret, pass its \${secret:psm_mask_*} reference exactly in a tool argument; pi-secret-mask injects the real value at tool execution time.`;

function storeFor(ctx: ExtensionContext): SecretArtifactStore {
	return new SecretArtifactStore(ctx.sessionManager.getSessionId());
}

async function resolveAuth(ctx: ExtensionContext) {
	if (!ctx.model) return { ok: false as const, error: "No active model for masked summarization." };
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) return { ok: false as const, error: auth.error };
	if (!auth.apiKey) return { ok: false as const, error: `No API key for ${ctx.model.provider}.` };
	return { ok: true as const, model: ctx.model, apiKey: auth.apiKey, headers: auth.headers };
}

export default function secretMaskExtension(pi: ExtensionAPI) {
	let enabled = true;
	let errorPatchWarningShown = false;
	const reportedConfigErrors = new Set<string>();
	const toolSecrets = new Map<string, InjectedSecret[]>();

	function patternsFor(ctx: ExtensionContext) {
		const configured = loadConfiguredPatterns(ctx.cwd);
		for (const error of configured.errors) {
			if (reportedConfigErrors.has(error)) continue;
			reportedConfigErrors.add(error);
			ctx.ui.notify(`pi-secret-mask config ignored: ${error}`, "warning");
		}
		return [...secretPatterns, ...configured.patterns];
	}

	pi.registerCommand("secret-mask", {
		description: "Control pi-secret-mask: status, on, off",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "on") {
				enabled = true;
				ctx.ui.notify("pi-secret-mask enabled", "info");
				return;
			}
			if (command === "off") {
				enabled = false;
				ctx.ui.notify("pi-secret-mask disabled", "warning");
				return;
			}
			if (command !== "" && command !== "status") {
				ctx.ui.notify("Usage: /secret-mask [status|on|off]", "warning");
				return;
			}
			const store = storeFor(ctx);
			const configured = loadConfiguredPatterns(ctx.cwd);
			ctx.ui.notify(
				`pi-secret-mask ${enabled ? "enabled" : "disabled"}; artifacts: ${store.root}; configured patterns: ${configured.patterns.length}`,
				"info",
			);
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_PROMPT}` };
	});

	pi.on("context", (event, ctx) => {
		if (!enabled) return;
		const projected = projectMessages(event.messages, storeFor(ctx), "context.messages", patternsFor(ctx));
		if (projected.maskCount > 0) ctx.ui.setStatus("pi-secret-mask", `masked ${projected.maskCount}`);
		return projected.maskCount > 0 ? { messages: projected.value } : undefined;
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled) return;
		const projected = projectUnknownStrings(event.payload, storeFor(ctx), "provider.payload", patternsFor(ctx));
		return projected.maskCount > 0 ? projected.value : undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		if (!enabled) return;
		const injected = injectSecretReferences(event.input, storeFor(ctx));
		if (injected.secrets.length === 0) return;
		replaceRecordContents(event.input, injected.value);
		toolSecrets.set(event.toolCallId, injected.secrets);
	});

	pi.on("tool_result", (event, ctx) => {
		if (!enabled) return;
		const secrets = toolSecrets.get(event.toolCallId) ?? [];
		toolSecrets.delete(event.toolCallId);
		if (secrets.length === 0) return;

		const leakedInError = event.isError && (containsInjectedSecret(event.content, secrets) || containsInjectedSecret(event.details, secrets));
		const content = redactInjectedSecrets(event.content, secrets);
		const details = redactInjectedSecrets(event.details, secrets);
		if (leakedInError && !errorPatchWarningShown) {
			errorPatchWarningShown = true;
			ctx.ui.notify(
				"pi-secret-mask detected an injected secret in a failing tool result. Some Pi versions ignore tool_result patches for errors.",
				"warning",
			);
		}
		return { content, details, isError: event.isError };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!enabled) return;
		const store = storeFor(ctx);
		const patterns = patternsFor(ctx);
		const messagesToSummarize = projectMessages(event.preparation.messagesToSummarize, store, "compact.messagesToSummarize", patterns);
		const turnPrefixMessages = projectMessages(event.preparation.turnPrefixMessages, store, "compact.turnPrefixMessages", patterns);
		const previousSummary = event.preparation.previousSummary
			? projectText(event.preparation.previousSummary, "compact.previousSummary", store, patterns)
			: { value: undefined, maskCount: 0 };
		const maskCount = messagesToSummarize.maskCount + turnPrefixMessages.maskCount + previousSummary.maskCount;
		if (maskCount === 0) return;

		const auth = await resolveAuth(ctx);
		if (!auth.ok) {
			ctx.ui.notify(`pi-secret-mask cancelled compaction: ${auth.error}`, "warning");
			return { cancel: true };
		}

		try {
			const summary = await generateSummary(
				[...messagesToSummarize.value, ...turnPrefixMessages.value],
				auth.model,
				event.preparation.settings.reserveTokens ?? 16384,
				auth.apiKey,
				auth.headers,
				event.signal,
				"Do not include secret values. Preserve only secret_ref markers and secret usage instructions.",
				previousSummary.value,
			);
			return {
				compaction: {
					summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: { maskedBy: "pi-secret-mask", maskCount },
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`pi-secret-mask cancelled compaction after masked summary failed: ${message}`, "warning");
			return { cancel: true };
		}
	});

	pi.on("session_before_tree", async (event, ctx) => {
		if (!enabled) return;
		const store = storeFor(ctx);
		const projected = projectSessionEntries(event.preparation.entriesToSummarize, store, "tree.entriesToSummarize", patternsFor(ctx));
		if (projected.maskCount === 0) return;

		const auth = await resolveAuth(ctx);
		if (!auth.ok) {
			ctx.ui.notify(`pi-secret-mask cancelled tree summary: ${auth.error}`, "warning");
			return { cancel: true };
		}

		const result = await generateBranchSummary(projected.value, {
			model: auth.model,
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: event.signal,
			customInstructions: event.preparation.customInstructions
				? `${event.preparation.customInstructions}\n\nDo not include secret values. Preserve only secret_ref markers.`
				: "Do not include secret values. Preserve only secret_ref markers.",
			replaceInstructions: event.preparation.replaceInstructions,
			reserveTokens: 16384,
		});

		if (result.aborted) return { cancel: true };
		if (result.error) {
			ctx.ui.notify(`pi-secret-mask cancelled tree summary after masked summary failed: ${result.error}`, "warning");
			return { cancel: true };
		}
		return {
			summary: {
				summary: result.summary ?? "No branch summary generated.",
				details: { readFiles: result.readFiles, modifiedFiles: result.modifiedFiles, maskedBy: "pi-secret-mask", maskCount: projected.maskCount },
			},
		};
	});
}
