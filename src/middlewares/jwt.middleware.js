const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const ApiError = require("../utils/api.error");

const jwtMiddleware = async (req, res, next) => {
  try {
    let token = req?.headers?.authorization?.split(" ")[1];
    if (!token) {
      throw ApiError.unauthorized("Access token required");
    }

    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      throw ApiError.unauthorized("Invalid token");
    }

    req.user = user;

    next();
  } catch (error) {
    next(ApiError.unauthorized("Invalid or expired token. Please login again"));
  }
};

module.exports = jwtMiddleware;
