export const ATTEMPT_STATUSES = [
  "IN PROGRESS",
  "COMPLETED",
  "WAITING FOR HUMAN",
  "FAILED",
  "SITE INVALID",
  "TEMP FAILURE",
] as const;

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
