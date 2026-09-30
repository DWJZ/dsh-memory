/**
 * dsh-memory — browser half (lazy-CJS client bundle).
 *
 * The host half writes two kinds of informational Session event: one for each
 * consolidation run (`dsh-memory/consolidation`) and one for the project a
 * Session was attributed to (`dsh-memory/project`). This half folds each of them
 * into a single read-only row of the Trajectory ledger.
 *
 * Both rows are plugin `extension` records: the ledger renders the one-line
 * summary this file builds and keeps the raw payload behind the shared details
 * panel, so the trajectory target never learns this plugin's field names. A row
 * needs no component, no slot and no stylesheet of its own — nothing in this
 * file produces DOM — and the two events are log-only, so no host interface is
 * involved either. Copy is machine-localizable, which is why the summaries are
 * built from the registered dictionary rather than from literals.
 */

/// <reference path="./client.d.ts" />
window.__ModuleLoader__.load({
	id: "dsh-memory",
	factory: (require) => {
		var module = { exports: {} };
		/** @type {Partial<DshMemoryClientExports>} */
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region locale
		const NS = "dshMemory";
		/** @type {Record<string, string>} */
		const zh = {
			consolidation: "记忆整理",
			statusSuccess: "成功",
			statusPartial: "部分完成",
			statusNoHumanTurn: "无人类发言",
			statusGap: "缺口",
			statusOther: "其它状态",
			triggerIdleDebounce: "空闲触发",
			triggerManualCommand: "手动命令",
			triggerDirect: "直接调用",
			triggerOther: "其它触发",
			seqRange: "seq {from}–{to}",
			gapNote: "这段区间从未被观测到",
			opCounts: "新增 {add} 更新 {update} 取代 {supersede} 无操作 {noop}",
			opRejected: "拒绝 {count}",
			opSkipped: "跳过 {count}",
			opFailed: "失败 {count}",
			project: "项目归属",
			matchedByRegistry: "按登记路径",
			matchedByWorkspace: "按 workspace",
			matchedByMarker: "按根标记",
			matchedByOther: "匹配方式未知",
			projectId: "项目 {id}",
			workspaceId: "workspace {id}",
			workspaceNone: "无 workspace"
		};
		/** @type {Record<string, string>} */
		const en = {
			consolidation: "Memory consolidation",
			statusSuccess: "success",
			statusPartial: "partial",
			statusNoHumanTurn: "no human turn",
			statusGap: "gap",
			statusOther: "other status",
			triggerIdleDebounce: "idle debounce",
			triggerManualCommand: "manual command",
			triggerDirect: "direct",
			triggerOther: "other trigger",
			seqRange: "seq {from}–{to}",
			gapNote: "this range was never observed",
			opCounts: "added {add}, updated {update}, superseded {supersede}, no-op {noop}",
			opRejected: "rejected {count}",
			opSkipped: "skipped {count}",
			opFailed: "failed {count}",
			project: "Project attribution",
			matchedByRegistry: "by registry path",
			matchedByWorkspace: "by workspace",
			matchedByMarker: "by root marker",
			matchedByOther: "unknown lookup",
			projectId: "project {id}",
			workspaceId: "workspace {id}",
			workspaceNone: "no workspace"
		};
		//#endregion

		//#region vocabulary
		/** Host-written event types this half renders. */
		const CONSOLIDATION_EVENT = "dsh-memory/consolidation";
		const PROJECT_EVENT = "dsh-memory/project";
		/** The one status that carries no operation counters. */
		const GAP_STATUS = "gap";
		/**
		 * Row symbols. The symbol says which trace this is — consolidation or
		 * project attribution — while the ledger tone carries the consolidation
		 * status, so the two never encode the same thing twice.
		 */
		const SYMBOL_CONSOLIDATION = "\u{1F9E0}";
		const SYMBOL_PROJECT = "\u{1F4C1}";
		/** Status → dictionary key. Closed: an unlisted status reads as "other". */
		/**
		 * Keyed by the host's own vocabulary; the host may write a value this
		 * build does not know, which is why lookups are by plain string.
		 * @type {Record<string, string>}
		 */
		const STATUS_KEYS = {
			success: "statusSuccess",
			partial: "statusPartial",
			"no-human-turn": "statusNoHumanTurn"
		};
		/** Status → ledger tone, from the closed set the trajectory target owns. */
		/**
		 * Keyed by the host's own vocabulary; the host may write a value this
		 * build does not know, which is why lookups are by plain string.
		 * @type {Record<string, string>}
		 */
		const STATUS_TONES = {
			success: "positive",
			partial: "warning",
			"no-human-turn": "neutral",
			gap: "critical"
		};
		/** Trigger → dictionary key. */
		/**
		 * Keyed by the host's own vocabulary; the host may write a value this
		 * build does not know, which is why lookups are by plain string.
		 * @type {Record<string, string>}
		 */
		const TRIGGER_KEYS = {
			"idle-debounce": "triggerIdleDebounce",
			"manual-command": "triggerManualCommand",
			direct: "triggerDirect"
		};
		/** Which lookup decided the project → dictionary key. */
		/**
		 * Keyed by the host's own vocabulary; the host may write a value this
		 * build does not know, which is why lookups are by plain string.
		 * @type {Record<string, string>}
		 */
		const MATCHED_BY_KEYS = {
			registry: "matchedByRegistry",
			workspace: "matchedByWorkspace",
			marker: "matchedByMarker"
		};
		//#endregion

		//#region summaries
		/**
		 * One payload field that is meant to be a string.
		 * @param {unknown} value - the payload field.
		 * @returns the value, or the empty string when the field is absent.
		 */
		/**
		 * @param {unknown} value - the value the host wrote.
		 * @returns {string}.
		 */
		function textOf(value) {
			return typeof value === "string" && value !== "" ? value : "";
		}

		/**
		 * One payload field that is meant to be a counter.
		 * @param {unknown} value - the payload field.
		 * @returns the value, or zero when the field is absent or not a number.
		 */
		/**
		 * @param {unknown} value - the value the host wrote.
		 * @returns {number}.
		 */
		function countOf(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : 0;
		}

		/**
		 * Join a row's symbol and its non-empty segments.
		 * @param symbol - the row's symbol.
		 * @param parts - summary segments, in reading order.
		 * @returns the one-line summary the ledger renders.
		 */
		/**
		 * @param {string} symbol - the row symbol.
		 * @param {string[]} parts - the rendered parts.
		 * @returns {string}.
		 */
		function join(symbol, parts) {
			return symbol + " " + parts.filter(part => part !== "").join(" \u00b7 ");
		}

		/**
		 * One status label, from the closed vocabulary the host writes.
		 * @param {unknown} status - the payload status.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns the localized label.
		 */
		/**
		 * @param {unknown} status - the payload status.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns {string}.
		 */
		function statusLabel(status, t) {
			const key = typeof status === "string" && STATUS_KEYS[status] !== undefined
				? STATUS_KEYS[status]
				: status === GAP_STATUS ? "statusGap" : "statusOther";
			return t(key);
		}

		/**
		 * The ledger tone a consolidation status asks for.
		 * @param {unknown} status - the payload status.
		 * @returns one tone from the closed set the trajectory target owns.
		 */
		/**
		 * @param {unknown} status - the payload status.
		 * @returns {string}.
		 */
		function statusTone(status) {
			return typeof status === "string" && STATUS_TONES[status] !== undefined
				? STATUS_TONES[status]
				: "neutral";
		}

		/**
		 * One trigger label.
		 * @param {unknown} trigger - the payload trigger.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns the localized label.
		 */
		/**
		 * @param {unknown} trigger - the payload trigger.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns {string}.
		 */
		function triggerLabel(trigger, t) {
			return t(typeof trigger === "string" && TRIGGER_KEYS[trigger] !== undefined
				? TRIGGER_KEYS[trigger]
				: "triggerOther");
		}

		/**
		 * The window a run or gap covers, when the payload carries one.
		 * @param {Record<string, unknown>} payload - the consolidation payload.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns the range label, or null when either end is absent.
		 */
		/**
		 * @param {Record<string, unknown>} payload - the host payload.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns {string | null} - null when the payload carries no range.
		 */
		function seqRangeLabel(payload, t) {
			if (typeof payload.from_seq !== "number" || typeof payload.to_seq !== "number") return null;
			return t("seqRange", { from: String(payload.from_seq), to: String(payload.to_seq) });
		}

		/**
		 * What a run wrote, as the four counters every non-gap audit carries.
		 * @param {unknown} operations - the payload's operation counters.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns the counts label.
		 */
		/**
		 * @param {unknown} operations - the plan operations.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns {string}.
		 */
		function operationCountsLabel(operations, t) {
			const counts = /** @type {Record<string, unknown>} */ (operations !== null && typeof operations === "object" ? operations : {});
			return t("opCounts", {
				add: String(countOf(counts.add)),
				update: String(countOf(counts.update)),
				supersede: String(countOf(counts.supersede)),
				noop: String(countOf(counts.noop))
			});
		}

		/**
		 * The counters a run only mentions when it has any: what the review threw
		 * away, what a duplicate or a conflict left unwritten, and what failed.
		 * @param {Record<string, unknown>} payload - the consolidation payload.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns one label per non-zero counter.
		 */
		function extraCountLabels(payload, t) {
			const operations = /** @type {Record<string, unknown>} */ (payload.operations !== null && typeof payload.operations === "object"
				? payload.operations
				: {});
			const labels = [];
			const rejected = countOf(payload.rejected);
			if (rejected > 0) labels.push(t("opRejected", { count: String(rejected) }));
			const skipped = countOf(operations.skipped);
			if (skipped > 0) labels.push(t("opSkipped", { count: String(skipped) }));
			const failed = countOf(operations.failed);
			if (failed > 0) labels.push(t("opFailed", { count: String(failed) }));
			return labels;
		}

		/**
		 * One consolidation run or gap as a single ledger line: what happened and
		 * when it ran, over which sequence range, and — for a run — what it wrote.
		 * @param {Record<string, unknown>} payload - the audit the host appended.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns the one-line summary.
		 */
		function consolidationSummary(payload, t) {
			const parts = [
				t("consolidation"),
				statusLabel(payload.status, t),
				triggerLabel(payload.trigger, t)
			];
			const range = seqRangeLabel(payload, t);
			if (range !== null) parts.push(range);
			if (payload.status === GAP_STATUS) {
				parts.push(t("gapNote"));
			} else {
				parts.push(operationCountsLabel(payload.operations, t));
				parts.push(...extraCountLabels(payload, t));
			}
			return join(SYMBOL_CONSOLIDATION, parts);
		}

		/**
		 * One project attribution as a single ledger line: which project the
		 * Session belongs to, which lookup decided it, and the two ids the store
		 * and the workspace are keyed by.
		 * @param {Record<string, unknown>} payload - the attribution the host appended.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns the one-line summary.
		 */
		function projectSummary(payload, t) {
			const parts = [t("project")];
			parts.push(textOf(payload.canonical_root));
			const matchedBy = typeof payload.matched_by === "string" ? MATCHED_BY_KEYS[payload.matched_by] : undefined;
			parts.push(t(matchedBy === undefined ? "matchedByOther" : matchedBy));
			const projectId = textOf(payload.project_id);
			if (projectId !== "") parts.push(t("projectId", { id: projectId }));
			const workspaceId = textOf(payload.workspace_id);
			parts.push(workspaceId === "" ? t("workspaceNone") : t("workspaceId", { id: workspaceId }));
			return join(SYMBOL_PROJECT, parts);
		}
		//#endregion

		//#region trajectory
		/**
		 * Build the Trajectory definition for one log-only event type.
		 *
		 * The row type comes from ui-trajectory (`extension`), which is what keeps
		 * this target free of any plugin's vocabulary: the definition supplies the
		 * summary, the emphasis and the payload, and the shared details panel shows
		 * the payload. Definitions are keyed by kind across every target, so each
		 * row carries its own kind.
		 * @param {object} options - the row's own vocabulary.
		 * @param options.kind - definition kind, unique across every target.
		 * @param options.eventType - the Session event type this row folds.
		 * @param options.idPrefix - stable prefix for the row's business identity.
		 * @param options.toneOf - ledger emphasis for one payload.
		 * @param options.summarize - builds the one-line summary from one payload.
		 * @param options.translate - this namespace's translate function.
		 * @returns the business definition.
		 */
		/**
		 * @param {TrajectoryRowOptions} options - what the row folds, and how it renders.
		 * @returns {DshTrajectoryRow}.
		 */
		function createTrajectoryRow(options) {
			const { kind, eventType, idPrefix, toneOf, summarize, translate } = options;
			/**
			 * @param {DshRowMatch} match - the matched event.
			 * @returns {{ seq: number, time: number, payload: unknown }} - the row state.
			 */
			const fold = (match) => ({
				seq: match.event.seq,
				time: typeof match.event.time === "number" ? match.event.time : 0,
				payload: match.event.data
			});
			return {
				kind,
				target: "trajectory",
				match: (event) => (event.type === eventType
					? { id: idPrefix + ":" + String(event.seq), role: "start" }
					: null),
				start: (_context, match) => fold(match),
				update: (context, match) => (match.event.type === eventType ? fold(match) : context.state),
				buildViewNode: (context) => {
					/** @type {{ seq: number, time: number, payload: unknown } | undefined} */
					const current = context.state;
					if (current === undefined) return null;
					return {
						key: context.key,
						kind: context.kind,
						id: context.id,
						target: "trajectory",
						anchorSeq: current.seq,
						location: context.start != null && context.start.location !== undefined
							? context.start.location
							: { kind: "unresolved" },
						data: {
							kind: "node",
							node: {
								kind: "extension",
								seq: current.seq,
								time: current.time,
								key: eventType,
								// The row folds only this plugin's own two event types, whose payload the host
								// writes as an object.
								text: summarize(/** @type {Record<string, unknown>} */ (current.payload), translate),
								value: current.payload,
								tone: toneOf(/** @type {Record<string, unknown>} */ (current.payload))
							}
						}
					};
				}
			};
		}

		/**
		 * The consolidation row.
		 * @param {Translate} translate - this namespace's translate function.
		 * @returns the business definition.
		 */
		/**
		 * @param {Translate} translate - this namespace's translate function.
		 * @returns {DshTrajectoryRow}.
		 */
		function createConsolidationRow(translate) {
			return createTrajectoryRow({
				kind: "trajectory-memory-consolidation",
				eventType: CONSOLIDATION_EVENT,
				idPrefix: "memory-consolidation",
				toneOf: payload => statusTone(payload.status),
				summarize: consolidationSummary,
				translate
			});
		}

		/**
		 * The project-attribution row.
		 * @param {Translate} translate - this namespace's translate function.
		 * @returns the business definition.
		 */
		function createProjectRow(translate) {
			return createTrajectoryRow({
				kind: "trajectory-memory-project",
				eventType: PROJECT_EVENT,
				idPrefix: "memory-project",
				// An attribution is a fact, not an outcome: it asks for no emphasis,
				// and its symbol is what makes it findable in the ledger.
				toneOf: () => "neutral",
				summarize: projectSummary,
				translate
			});
		}
		//#endregion

		//#region plugin
		const inject = ["locale", "uiConversation"];

		/**
		 * Register the dictionaries and the two ledger rows.
		 * @param {DshClientContext} ctx - this plugin's Client context.
		 */
		/**
		 * @param {DshClientContext} ctx - this plugin's Client context.
		 */
		function apply(ctx) {
			// The binding reads the active locale at call time, so one function
			// serves every later language switch.
			const translate = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-memory: dictionaries");
			// Both events are appends this plugin makes to the Session log, so the
			// rows are folded from the event stream: no host interface is involved.
			ctx.effect(() => ctx.uiConversation.events.register(createConsolidationRow(translate)),
				"dsh-memory: consolidation definition");
			ctx.effect(() => ctx.uiConversation.events.register(createProjectRow(translate)),
				"dsh-memory: project definition");
		}

		exports.apply = apply;
		exports.inject = inject;
		// Exported for the offline smoke test.
		exports.consolidationSummary = consolidationSummary;
		exports.projectSummary = projectSummary;
		exports.statusTone = statusTone;
		exports.createConsolidationRow = createConsolidationRow;
		exports.createProjectRow = createProjectRow;
		exports.CONSOLIDATION_EVENT = CONSOLIDATION_EVENT;
		exports.PROJECT_EVENT = PROJECT_EVENT;
		//#endregion

		return module.exports;
	}
});
