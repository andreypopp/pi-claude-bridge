/**
 * Would pi-observational-memory answer this compaction?
 *
 * pi's extension runner (core/extensions/runner.js, `emit`) runs *every*
 * `session_before_compact` handler and keeps the LAST non-cancel result, so with
 * the bridge loaded after observational memory the bridge's Claude Code
 * summarization silently replaces OM's — which needs no model call at all, and
 * whose compaction `details` are the only place /om:status reads its visible
 * pool from. Measured on a real session: OM's rendering would have been 4,632
 * and 79,941 characters at the last two compactions; both entries carried the
 * bridge's summary instead.
 *
 * So the bridge declines when OM is certain to answer. The rule has to be
 * faithful to OM's own emptiness rule in both directions: OM declines too when
 * its projection is empty, and then pi's *native* summarizer runs, which on a
 * bridge model is the hang the takeover exists to prevent (issue #8). Being
 * stricter than OM costs only the old behaviour (OM's summary thrown away);
 * being laxer costs the hang.
 *
 * This reproduces the emptiness question from OM's own sources — hooks/
 * compaction-hook.ts, session-ledger/{projection,render-summary,types}.ts of
 * pi-observational-memory 3.1.4 — over the two inputs OM reads,
 * `event.branchEntries` and `event.preparation.firstKeptEntryId`. The package is
 * deliberately not imported: it is not a dependency of the bridge, and a bridge
 * that failed to load without it would be worse than one that summarizes twice.
 *
 * OM's entries in the branch are not, on their own, the signal that OM is
 * there: a session resumed with the extension since disabled still carries
 * them, and a decline judged from history alone would hand the takeover to a
 * handler nobody registered — pi's `emit()` then returns nothing, satisfying
 * neither OM's answer nor the bridge's, and pi falls through to its native
 * summarizer over a bridge model (the issue #8 hang again). So the projection
 * above answers "would OM's handler produce a summary if it ran", and
 * `observationalMemoryIsLoaded` answers the separate question of whether it is
 * registered to run at all; `observationalMemoryDecision` only reports
 * `willSummarize` when both are true.
 *
 * The loaded check reads `pi.getCommands()` for `om:status`, a slash command
 * OM's `index.ts` registers unconditionally — including in
 * `PI_OBSERVATIONAL_MEMORY_PASSIVE` mode, which only changes what its observer
 * does with a model, not what it registers. It is pi's own public contract
 * (`ExtensionAPI.getCommands()`), not an internal reached into: any extension
 * exposing the same command under a different implementation would still be
 * answering "OM's compaction hook is registered," which is the only thing this
 * needs to know. The alternative of grepping `ExtensionRunner.getExtensionPaths()`
 * for `pi-observational-memory` was passed over for the same reason the package
 * itself is not imported here — it names an install layout OM does not publish
 * as part of its contract, where a path a future OM release renames or nests
 * differently silently reopens this gap; `om:status` is behaviour OM commits to
 * keeping working for its own users.
 */

const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
const OM_FOLDED = "om.folded";
const OM_STATUS_COMMAND = "om:status";

const RELEVANCE_VALUES = ["low", "medium", "high", "critical"];
const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return !!value && typeof value === "object";
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isTokenCount(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isMemoryId(value: unknown): value is string {
	return typeof value === "string" && MEMORY_ID_PATTERN.test(value);
}

/** OM's isObservation. A record failing it is skipped by the fold entirely. */
function isObservation(value: unknown): value is Rec & { id: string } {
	if (!isRec(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		isNonEmptyString(value.timestamp) &&
		typeof value.relevance === "string" &&
		RELEVANCE_VALUES.includes(value.relevance) &&
		isNonEmptyStringArray(value.sourceEntryIds) &&
		isTokenCount(value.tokenCount)
	);
}

/** OM's isReflection — content is single-line there, and a multi-line one is dropped. */
function isReflection(value: unknown): value is Rec & { id: string } {
	if (!isRec(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		!/\r|\n/.test(value.content) &&
		isNonEmptyStringArray(value.supportingObservationIds) &&
		isTokenCount(value.tokenCount)
	);
}

type CustomData = { coversUpToId: string; observations?: unknown[]; reflections?: unknown[]; observationIds?: unknown[] };

/** A V3 memory entry of `customType` whose data passes OM's validator for it. */
function memoryEntry(entry: unknown, customType: string): CustomData | undefined {
	if (!isRec(entry) || entry.type !== "custom" || entry.customType !== customType) return undefined;
	const data = entry.data;
	if (!isRec(data) || !isNonEmptyString(data.coversUpToId)) return undefined;
	if (customType === OM_OBSERVATIONS_RECORDED) {
		if (!Array.isArray(data.observations) || data.observations.length === 0) return undefined;
		if (!data.observations.every(isObservation)) return undefined;
	} else if (customType === OM_REFLECTIONS_RECORDED) {
		if (!Array.isArray(data.reflections) || data.reflections.length === 0) return undefined;
		if (!data.reflections.every(isReflection)) return undefined;
	} else {
		if (!isNonEmptyStringArray(data.observationIds)) return undefined;
	}
	return data as CustomData;
}

/** OM's isMemoryDetails, for the compaction entries a full-fold boundary is read from. */
function isMemoryDetails(value: unknown): value is Rec & { fullFold: boolean } {
	if (!isRec(value)) return false;
	return (
		value.type === OM_FOLDED &&
		value.version === 1 &&
		typeof value.fullFold === "boolean" &&
		Array.isArray(value.observations) &&
		value.observations.every(isObservation) &&
		Array.isArray(value.reflections) &&
		value.reflections.every(isReflection)
	);
}

/** -1 means "no boundary": OM's noneBoundary, which covers nothing. */
function latestFullFoldBoundary(entries: readonly unknown[], indexes: Map<string, number>): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!isRec(entry) || entry.type !== "compaction") continue;
		if (!isMemoryDetails(entry.details) || !entry.details.fullFold) continue;
		if (!isNonEmptyString(entry.firstKeptEntryId)) continue;
		const index = indexes.get(entry.firstKeptEntryId);
		if (index !== undefined) return index;
	}
	return -1;
}

type Sizes = { observations: number; reflections: number };

function isEmpty(sizes: Sizes): boolean {
	return sizes.observations === 0 && sizes.reflections === 0;
}

/** OM's foldProjection, counting only: what renderSummary needs is whether it is empty. */
function foldProjection(
	entries: readonly unknown[],
	indexes: Map<string, number>,
	boundaries: { observations: number; reflections: number; drops: number },
): Sizes {
	const observationIds: string[] = [];
	const seenObservations = new Set<string>();
	const reflections = new Set<string>();
	const dropped = new Set<string>();
	const covered = (data: CustomData, boundary: number): boolean => {
		const index = indexes.get(data.coversUpToId) ?? -1;
		return index >= 0 && boundary >= 0 && index <= boundary;
	};

	for (const entry of entries) {
		const recorded = memoryEntry(entry, OM_OBSERVATIONS_RECORDED);
		if (recorded) {
			if (covered(recorded, boundaries.observations)) {
				for (const observation of recorded.observations as { id: string }[]) {
					if (seenObservations.has(observation.id)) continue;
					seenObservations.add(observation.id);
					observationIds.push(observation.id);
				}
			}
			continue;
		}
		const reflected = memoryEntry(entry, OM_REFLECTIONS_RECORDED);
		if (reflected) {
			if (covered(reflected, boundaries.reflections)) {
				for (const reflection of reflected.reflections as { id: string }[]) reflections.add(reflection.id);
			}
			continue;
		}
		const drops = memoryEntry(entry, OM_OBSERVATIONS_DROPPED);
		if (drops && covered(drops, boundaries.drops)) {
			for (const id of drops.observationIds as string[]) dropped.add(id);
		}
	}

	return {
		observations: observationIds.filter((id) => !dropped.has(id)).length,
		reflections: reflections.size,
	};
}

export type OmDecision = {
	/** True when OM is loaded and its projection is non-empty however it resolves its pool budget. */
	willSummarize: boolean;
	/** Sizes of OM's ordinary (non-full-fold) projection, for the debug line. */
	observations: number;
	reflections: number;
};

/**
 * Is observational memory loaded as an extension in this session? Reads
 * `pi.getCommands()` for `om:status`, which OM's `index.ts` registers
 * unconditionally on load — the contract explained above the constant.
 */
export function observationalMemoryIsLoaded(commands: readonly { name: string }[]): boolean {
	return commands.some((command) => command.name === OM_STATUS_COMMAND);
}

/**
 * Whether observational memory's `session_before_compact` handler will return a
 * summary for this compaction, rather than declining to pi's native summarizer.
 *
 * `omLoaded` is `observationalMemoryIsLoaded`'s answer, passed in rather than
 * computed here so this stays a pure function over the same two inputs OM's own
 * handler reads. When OM is not loaded there is no handler to answer regardless
 * of what the branch's history carries, so this returns false without looking
 * at the projections at all.
 *
 * OM folds observations up to `firstKeptEntryId` and reflections and drops only
 * up to the newest full-fold compaction boundary; if that pool's token count
 * reaches its `observationsPoolMaxTokens` it re-folds everything up to the cut
 * instead (a "full fold"), where the wider drop boundary can tombstone more
 * than the narrow one did. That threshold is OM's own config, which the bridge
 * cannot read — so both projections are computed and only a non-empty answer
 * from each counts as certain.
 */
export function observationalMemoryDecision(
	branchEntries: readonly unknown[],
	firstKeptEntryId: string | undefined,
	omLoaded: boolean,
): OmDecision {
	const indexes = new Map<string, number>();
	for (let i = 0; i < branchEntries.length; i++) {
		const entry = branchEntries[i];
		if (isRec(entry) && isNonEmptyString(entry.id)) indexes.set(entry.id, i);
	}
	const cut = isNonEmptyString(firstKeptEntryId) ? indexes.get(firstKeptEntryId) ?? -1 : -1;
	const maintenance = latestFullFoldBoundary(branchEntries, indexes);

	const normal = foldProjection(branchEntries, indexes, {
		observations: cut,
		reflections: maintenance,
		drops: maintenance,
	});
	const full = foldProjection(branchEntries, indexes, { observations: cut, reflections: cut, drops: cut });

	return {
		willSummarize: omLoaded && !isEmpty(normal) && !isEmpty(full),
		observations: normal.observations,
		reflections: normal.reflections,
	};
}
