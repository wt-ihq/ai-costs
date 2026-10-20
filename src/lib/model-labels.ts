/**
 * Display names for model keys vendors report in machine form (spend_facts.model keeps the key).
 * Pure and client-safe.
 */
const MODEL_LABEL: Record<string, string> = {
  github_bugbot: "Cursor - Bugbot", // Cursor's GitHub pull-request reviewer (a service account)
};

export function modelLabel(model: string): string {
  return MODEL_LABEL[model] ?? model;
}
