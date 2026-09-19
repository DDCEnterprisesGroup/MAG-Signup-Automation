export interface MagBotClientOptions {
  url: string; publishableKey: string; email: string; password: string;
  fetchImpl?: typeof fetch;
}
export class MagSupabaseIntakeClient {
  constructor(options: MagBotClientOptions);
  authenticate(): Promise<void>;
  submitIntake(payload: unknown): Promise<unknown>;
}
export function validateIntake(payload: unknown): unknown;
