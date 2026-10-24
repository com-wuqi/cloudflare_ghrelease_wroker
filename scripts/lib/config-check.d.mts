export function stripJsonComments(text: string): string;
export function stripTrailingCommas(text: string): string;
export function parseConfig(text: string): Record<string, unknown>;
export function validateConfig(config: Record<string, unknown>): string[];
