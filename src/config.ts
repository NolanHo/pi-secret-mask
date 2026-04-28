import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultAgentDir } from "./artifacts.js";
import type { SecretPattern } from "./patterns.js";
import { secretMarker } from "./patterns.js";

export type LiteralPatternConfig = {
	type: "literal";
	name?: string;
	value: string;
	label?: string;
	caseSensitive?: boolean;
};

export type RegexPatternConfig = {
	type: "regex";
	name?: string;
	pattern: string;
	flags?: string;
	label?: string;
	secretGroup?: number;
};

export type CustomPatternConfig = LiteralPatternConfig | RegexPatternConfig;

export interface SecretMaskConfigFile {
	patterns?: CustomPatternConfig[];
}

export interface LoadedSecretMaskConfig {
	patterns: SecretPattern[];
	paths: string[];
	errors: string[];
}

export function configPaths(cwd: string): string[] {
	const paths = [join(defaultAgentDir(), "pi-secret-mask", "config.json"), join(cwd, ".pi", "secret-mask.json")];
	const envPath = process.env.PI_SECRET_MASK_CONFIG?.trim();
	if (envPath) paths.push(envPath);
	return paths;
}

export function loadConfiguredPatterns(cwd: string): LoadedSecretMaskConfig {
	const patterns: SecretPattern[] = [];
	const paths: string[] = [];
	const errors: string[] = [];

	for (const path of configPaths(cwd)) {
		if (!existsSync(path)) continue;
		paths.push(path);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as SecretMaskConfigFile;
			const compiled = patternsFromConfigObject(parsed, path);
			patterns.push(...compiled.patterns);
			errors.push(...compiled.errors);
		} catch (error) {
			errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { patterns, paths, errors };
}

export function patternsFromConfigObject(config: SecretMaskConfigFile, source = "config"): LoadedSecretMaskConfig {
	const patterns: SecretPattern[] = [];
	const errors: string[] = [];
	const specs = Array.isArray(config.patterns) ? config.patterns : [];

	for (let i = 0; i < specs.length; i += 1) {
		try {
			patterns.push(patternFromConfig(specs[i], source, i));
		} catch (error) {
			errors.push(`${source}: patterns[${i}]: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { patterns, paths: [], errors };
}

function patternFromConfig(spec: CustomPatternConfig, source: string, index: number): SecretPattern {
	if (spec.type === "literal") return literalPatternFromConfig(spec, source, index);
	if (spec.type === "regex") return regexPatternFromConfig(spec, source, index);
	throw new Error(`unsupported pattern type ${(spec as { type?: unknown }).type}`);
}

function literalPatternFromConfig(spec: LiteralPatternConfig, source: string, index: number): SecretPattern {
	if (typeof spec.value !== "string" || spec.value.length === 0) {
		throw new Error("literal pattern requires non-empty string value");
	}
	const flags = spec.caseSensitive === false ? "gi" : "g";
	const label = spec.label || spec.name || "configured literal";
	return {
		name: spec.name || `literal-${index}`,
		description: `Literal secret from ${source}`,
		pattern: new RegExp(escapeRegExp(spec.value), flags),
		secret: (m) => m[0],
		replace: (m, id) => secretMarker(id, label, [...m[0]].length),
	};
}

function regexPatternFromConfig(spec: RegexPatternConfig, source: string, index: number): SecretPattern {
	if (typeof spec.pattern !== "string" || spec.pattern.length === 0) {
		throw new Error("regex pattern requires non-empty pattern string");
	}
	const flags = normalizeRegexFlags(spec.flags);
	const regex = new RegExp(spec.pattern, flags);
	const group = Number.isInteger(spec.secretGroup) ? spec.secretGroup ?? 0 : 0;
	const label = spec.label || spec.name || "configured regex";
	return {
		name: spec.name || `regex-${index}`,
		description: `Regex secret from ${source}`,
		pattern: regex,
		secret: (m) => {
			const value = m[group];
			if (typeof value !== "string") throw new Error(`regex pattern ${spec.name || index} did not produce group ${group}`);
			return value;
		},
		replace: (m, id) => {
			const secret = m[group];
			if (group === 0 || typeof secret !== "string") return secretMarker(id, label, [...m[0]].length);
			const offset = m[0].indexOf(secret);
			if (offset < 0) return secretMarker(id, label, [...secret].length);
			return `${m[0].slice(0, offset)}${secretMarker(id, label, [...secret].length)}${m[0].slice(offset + secret.length)}`;
		},
	};
}

function normalizeRegexFlags(flags: string | undefined): string {
	let next = flags || "";
	if (!next.includes("g")) next += "g";
	if (next.includes("y")) next = next.replace(/y/g, "");
	return [...new Set(next)].join("");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
