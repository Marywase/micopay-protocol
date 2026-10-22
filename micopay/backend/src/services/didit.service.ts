// Didit hosted-verification client (#315 — [4b] KYC Provider Integration).
//
// Sigue la API v3 de Didit (docs.didit.me, consultada 2026-10-16): sesion en
// POST /v3/session/, estados con mayusculas y espacios exactos, y el motivo de
// rechazo dentro de los `warnings` de cada modulo de `decision`.
//
// Probado de punta a punta contra el sandbox de Didit (2026-10-16/17): sesion,
// webhook firmado y nivel 1 y 2 grabados en Postgres.
import { breakers } from "../lib/breakers.js";
import { breakerFetch, isIdempotentMethod } from "../lib/circuitBreaker.js";

const DIDIT_API = process.env.DIDIT_API_URL ?? "https://verification.didit.me";

function diditClient(path: string, init: RequestInit = {}): Promise<Response> {
  const apiKey = process.env.DIDIT_API_KEY;
  if (!apiKey) {
    throw new Error("DIDIT_API_KEY not configured");
  }

  // Session creation is a POST: never retried, so a lost response cannot
  // open a second session behind the user's back.
  return breakerFetch(breakers.didit, `${DIDIT_API}${path}`, {
    ...init,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      ...init.headers,
    },
  }, { idempotent: isIdempotentMethod(init.method) });
}

export interface CreateDiditSessionParams {
  /**
   * Identificador estable de la persona (nuestro user id). Didit lo usa para
   * reutilizar sesiones y detectar duplicados. No decide nada al volver: el
   * webhook resuelve usuario y nivel con `kyc_didit_sessions`.
   */
  vendorData: string;
  /** Workflow de Didit; cada nivel de KYC tiene el suyo. */
  workflowId: string;
}

export interface DiditSession {
  sessionId: string;
  url: string;
}

/**
 * Workflow de Didit para cada nivel. El nivel 2 agrega comprobante de
 * domicilio, asi que NO puede caer al workflow del nivel 1: sin
 * DIDIT_WORKFLOW_ID_L2 no hay nivel 2.
 */
export function diditWorkflowIdForLevel(level: 1 | 2): string | undefined {
  return level === 2 ? process.env.DIDIT_WORKFLOW_ID_L2 : process.env.DIDIT_WORKFLOW_ID;
}

export async function createDiditSession(params: CreateDiditSessionParams): Promise<DiditSession> {
  const response = await diditClient("/v3/session/", {
    method: "POST",
    body: JSON.stringify({ workflow_id: params.workflowId, vendor_data: params.vendorData }),
  });
  if (!response.ok) {
    throw new Error(`Didit API error: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { session_id: string; url: string };
  return { sessionId: data.session_id, url: data.url };
}

export type DiditDecisionStatus = "approved" | "rejected" | "pending";

/**
 * Maps Didit's webhook/decision status string to our three-value status.
 * Provider-response-driven per #315's legal note: we only ever branch on
 * "did this session end up approved or not", never on which documents/fields
 * Didit collected — that stays entirely on Didit's side of the integration.
 */
//
// Didit compara los estados exactos ("Kyc Expired" con K mayuscula sola).
// "Expired", "Abandoned" y "Kyc Expired" terminan la sesion sin aprobacion:
// la persona tiene que abrir una nueva, asi que cuentan como rechazo. "In
// Review", "Resubmitted" y los de en curso siguen pendientes.
export function mapDiditStatus(raw: string | undefined | null): DiditDecisionStatus {
  switch (raw) {
    case "Approved":
      return "approved";
    case "Declined":
    case "Abandoned":
    case "Expired":
    case "Kyc Expired":
      return "rejected";
    default:
      return "pending";
  }
}

/**
 * Motivo del resultado en v3: no hay `decision.reason`; cada modulo de
 * `decision` (id_verifications, liveness_checks, ...) trae `warnings` con un
 * codigo `risk`. Solo se guardan esos codigos, nunca las descripciones ni
 * otros datos del payload, que pueden llevar datos personales.
 */
export function extractDiditDecisionReason(decision: unknown): string | null {
  if (!decision || typeof decision !== "object") return null;
  const risks = new Set<string>();
  for (const value of Object.values(decision as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const warnings = (item as { warnings?: unknown })?.warnings;
      if (!Array.isArray(warnings)) continue;
      for (const w of warnings) {
        const risk = (w as { risk?: unknown })?.risk;
        if (typeof risk === "string" && risk) risks.add(risk);
      }
    }
  }
  return risks.size ? [...risks].join(",").slice(0, 500) : null;
}
