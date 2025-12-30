class ApiResponse {
    constructor(
        statusCode = 200,
        message = "Success",
        data = null,
        success = true,
        meta = null
    ) {
        this.statusCode = statusCode;
        this.message = message;
        this.data = data;
        this.success = success;
        this.meta = meta;
        this.timestamp = new Date().toISOString();
    }

    static success(message = "Success", data = null, meta = null) {
        return new ApiResponse(200, message, data, true, meta);
    }

    static created(message = "Resource created successfully", data = null) {
        return new ApiResponse(201, message, data);
    }

    static paginated(message = "Data retrieved successfully", data, pagination) {
        return new ApiResponse(200, message, data, true, { pagination });
    }
}

module.exports = ApiResponse;