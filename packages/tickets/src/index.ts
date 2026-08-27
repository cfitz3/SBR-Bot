/**
 * `@sbr/tickets` — the ticket domain, with no I/O in it.
 *
 * Everything that decides something lives here: who may open a ticket and why
 * not, what its channel is called, when it closes itself, what the panel looks
 * like, and how the transcript reads. The Discord side and the web panel are
 * both callers, which is what keeps them from disagreeing.
 */
export {
  CATEGORY_LIMITS,
  PERMANENT_CATEGORY_KEYS,
  SEED_CATEGORIES,
  categoryById,
  categoryByKey,
  findCategory,
  isPermanentCategory,
  openableCategories,
  orderCategories,
  validateCategory,
  type SeedCategory,
} from "./categories.js";

export { defaultSettings } from "./defaults.js";

export {
  evaluateEligibility,
  isOpen,
  localTime,
  nextOpening,
  type Eligibility,
  type EligibilityInput,
  type EligibilityReason,
} from "./eligibility.js";

export {
  RESUME_MESSAGE_COUNT,
  averageRating,
  averageResolutionTimeMs,
  averageResponseTimeMs,
  canAct,
  claim,
  close,
  isPendingClosure,
  release,
  requestClose,
  sweep,
  transfer,
  type Actor,
  type ClaimChange,
  type CloseRequestChange,
  type LifecycleRefusal,
  type LifecycleResult,
  type SweepAction,
  type SweepInput,
} from "./lifecycle.js";

export {
  PLACEHOLDERS,
  UNKNOWN,
  channelName,
  expand,
  humanDuration,
  type NamingContext,
} from "./naming.js";

export {
  TICKET_NAMESPACE,
  newTicketId,
  panelCategories,
  panelSelectId,
  renderPanel,
  suggestedStyle,
  ticketControls,
  type PanelProblem,
  type PanelResult,
  type RenderedPanel,
} from "./panel.js";

export { compileTag, compileTags, findTag, matchTag, type CompiledTag } from "./tags.js";

export {
  toHtml,
  toMarkdown,
  transcriptFilename,
  type TranscriptHeader,
} from "./transcript.js";
