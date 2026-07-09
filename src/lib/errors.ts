import type { FastifyReply } from "fastify";

type AnthropicErrorType =
  | "authentication_error"
  | "permission_error"
  | "invalid_request_error"
  | "rate_limit_error"
  | "billing_error"
  | "not_found_error"
  | "overloaded_error";

const STATUS_BY_TYPE: Record<AnthropicErrorType, number> = {
  authentication_error: 401,
  permission_error: 403,
  invalid_request_error: 400,
  rate_limit_error: 429,
  billing_error: 402,
  not_found_error: 404,
  overloaded_error: 529,
};

/** Sends an error body shaped like Anthropic's own API so client SDKs parse it identically. */
export function sendAnthropicError(reply: FastifyReply, type: AnthropicErrorType, message: string): void {
  reply.code(STATUS_BY_TYPE[type]).send({
    type: "error",
    error: { type, message },
  });
}
