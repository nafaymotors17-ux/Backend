class ApiError extends Error {
  constructor(
    statusCode = 500,
    message = "Something went wrong",
    type = "API_ERROR",
    details = null,
    success = false
  ) {
    super(message);
    this.statusCode = statusCode;
    this.success = success;
    this.type = type;
    this.details = details;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = "Bad Request", details = null) {
    return new ApiError(400, message, "BAD_REQUEST", details);
  }

  static unauthorized(message = "Unauthorized", details = null) {
    return new ApiError(401, message, "UNAUTHORIZED", details);
  }

  static forbidden(message = "Forbidden", details = null) {
    return new ApiError(403, message, "FORBIDDEN", details);
  }

  static notFound(message = "Resource not found", details = null) {
    return new ApiError(404, message, "NOT_FOUND", details);
  }

  static conflict(message = "Resource already exists", details = null) {
    return new ApiError(409, message, "CONFLICT", details);
  }

  static validationError(message = "Validation failed", details = null) {
    return new ApiError(422, message, "VALIDATION_ERROR", details);
  }

  static internalError(message = "Internal server error", details = null) {
    return new ApiError(500, message, "INTERNAL_ERROR", details);
  }
}

module.exports = ApiError;
