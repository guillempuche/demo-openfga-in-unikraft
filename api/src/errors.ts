import { Schema } from 'effect'
import { HttpApiSchema } from 'effect/http-api'

// Typed errors: each one is part of the API contract (and of the OpenAPI
// document) with its own HTTP status.

/** The request can't be answered as asked (OpenFGA rejected it as invalid). */
export class BadRequest extends Schema.TaggedError<BadRequest>()('BadRequest', {
  message: Schema.String,
}) {}

/** OpenFGA couldn't be reached or failed; the message keeps its HTTP status. */
export class UpstreamError extends Schema.TaggedError<UpstreamError>()('UpstreamError', {
  message: Schema.String,
}) {}

/** A /bench run is already in progress (one at a time). */
export class Busy extends Schema.TaggedError<Busy>()('Busy', {
  message: Schema.String,
}) {}

export const BadRequestError = BadRequest.pipe(HttpApiSchema.status(400))
export const UpstreamErrorError = UpstreamError.pipe(HttpApiSchema.status(502))
export const BusyError = Busy.pipe(HttpApiSchema.status(429))
