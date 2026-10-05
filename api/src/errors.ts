import { ErrorReporter, Schema } from 'effect'

// Typed errors: each one is part of the API contract (and of the OpenAPI
// document) with its own HTTP status (httpApiStatus). They are expected
// answers, not faults, so error reporting skips them (ErrorReporter.ignore) and
// only defects get logged (see main.ts).

/** The request can't be answered as asked: it failed validation, or OpenFGA rejected it as invalid. */
export class BadRequest extends Schema.TaggedError<BadRequest>()('BadRequest', { message: Schema.String }, { httpApiStatus: 400 }) {
  override readonly [ErrorReporter.ignore] = true
}

/** The body isn't declared as JSON (only application/json, or no content-type, is accepted). */
export class UnsupportedMediaType extends Schema.TaggedError<UnsupportedMediaType>()(
  'UnsupportedMediaType',
  { message: Schema.String },
  { httpApiStatus: 415 },
) {
  override readonly [ErrorReporter.ignore] = true
}

/** A /bench run is already in progress (one at a time). */
export class Busy extends Schema.TaggedError<Busy>()('Busy', { message: Schema.String }, { httpApiStatus: 429 }) {
  override readonly [ErrorReporter.ignore] = true
}

/** OpenFGA couldn't be reached or failed; the message keeps its HTTP status. */
export class UpstreamError extends Schema.TaggedError<UpstreamError>()('UpstreamError', { message: Schema.String }, { httpApiStatus: 502 }) {
  override readonly [ErrorReporter.ignore] = true
}
