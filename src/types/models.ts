export const ATTEMPT_STATUSES = [
  "IN PROGRESS",
  "COMPLETED",
  "WAITING FOR HUMAN",
  "FAILED",
  "SITE INVALID",
  "TEMP FAILURE",
  "OPERATOR_DEFERRED",
  // Durable, first-class "a final external submit may have been sent for this
  // attempt; its outcome is not yet safely resolved" state. Written to disk
  // BEFORE the final click. It is NOT automatically processable: it is released
  // only by an explicit `mag handoff resume <person> <site>`. This is the
  // submission-duplicate-protection invariant — never a free-text note.
  "AWAITING CONFIRMATION",
] as const;

/** Explicit-operator-authorization marker recognised by eligibility + resume. */
export const OPERATOR_RESUME_MARKER = "Operator authorized resume";

/** Whether an attempt is in the durable submission-uncertain quarantine. */
export function isSubmissionUncertain(status: AttemptStatus): boolean {
  return status === "AWAITING CONFIRMATION";
}

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const ERROR_CATEGORIES = [
  "NETWORK_TIMEOUT",
  "DNS_FAILURE",
  "HTTP_404",
  "HTTP_403",
  "HTTP_5XX",
  "REDIRECT",
  "REDIRECT_LOOP",
  "ACCESS_BLOCKED",
  "SIGNUP_NOT_FOUND",
  "FORM_NOT_RECOGNIZED",
  "REQUIRED_MANUAL_FIELD",
  "CAPTCHA",
  "EMAIL_VERIFICATION",
  "SMS_VERIFICATION",
  "HUMAN_CONSENT",
  "SITE_ERROR",
  "AUTOMATION_ERROR",
  "TEMPORARY_ERROR",
  "OPERATOR_DEFERRED",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];
export type RetryEligible = "YES" | "NO";

export interface Site {
  rowNumber: number;
  id: string;
  name: string;
  signupUrl: string;
  active: boolean;
  status: string;
  lastChecked: string;
  finalUrl: string;
  notes: string;
}

export interface PersonProfile {
  rowNumber: number;
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  dob: string;
  occupation: string;
  annualIncome: string;
  password: string;
  dynamicFields: Record<string, string>;
  status: string;
  currentSiteId: string;
  lastUpdated: string;
}

export interface SignupIntake {
  requestId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  dob?: string;
  occupation?: string;
  annualIncome?: string;
  password?: string;
}

export type ProfileField =
  | "firstName"
  | "lastName"
  | "phone"
  | "email"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "dob"
  | "dobMonth"
  | "dobDay"
  | "dobYear"
  | "occupation"
  | "annualIncome"
  | "password";

export type AccountFlowContext = "registration" | "login" | "password-reset" | "ambiguous";

export interface ReconciliationReport {
  peopleAssigned: string[];
  sitesAssigned: string[];
  peopleDefaultedPending: string[];
  sitesDefaultedActive: string[];
  duplicateSites: Array<{ duplicateId: string; canonicalId: string }>;
  knownFields: string[];
  unknownFields: string[];
  restrictedFields: string[];
  changedPersonIds: string[];
  changedSiteIds: string[];
}

export interface PersonProgress {
  personId: string;
  name: string;
  status: string;
  completed: number;
  remaining: number;
  humanReview: number;
}

export interface AttemptRecord {
  rowNumber: number;
  attemptId: string;
  personId: string;
  siteId: string;
  attemptedAt: string;
  status: AttemptStatus;
  formStep: number;
  lastUrl: string;
  errorType: ErrorCategory | "";
  retryEligible: RetryEligible;
  notes: string;
}

export interface AttemptUpdate {
  status?: AttemptStatus;
  formStep?: number;
  lastUrl?: string;
  errorType?: ErrorCategory | "";
  retryEligible?: RetryEligible;
  notes?: string;
}

export interface SiteIssue {
  siteId: string;
  siteName: string;
  url: string;
  dateChecked: string;
  issueType: ErrorCategory | "REDIRECT";
  httpStatus: number | "";
  redirectUrl: string;
  globalStatus: "ACTIVE" | "INVALID" | "REDIRECTED" | "BLOCKED" | "TEMP ERROR";
  notes: string;
}

export interface RunStats {
  completed: number;
  failed: number;
  waitingForHuman: number;
  skipped: number;
  deferred: number;
}

export interface PersonSummary {
  personId: string;
  name: string;
  attemptedAt: string;
  sitesAttempted: number;
  passed: number;
  failed: number;
  humanReview: number;
}

export interface HumanHandoffReason {
  category: ErrorCategory;
  reason: string;
}

export class StopRunError extends Error {
  constructor(message = "Operator requested a safe stop") {
    super(message);
    this.name = "StopRunError";
  }
}

/** Raised at an engine checkpoint when an operator hotkey redirects the current site. */
export class SiteControlSignal extends Error {
  constructor(readonly kind: "defer" | "retry" | "skip") {
    super(`Operator ${kind} for current site`);
    this.name = "SiteControlSignal";
  }
}
