const User = require("../models/user.model");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/api.error");
const ApiResponse = require("../utils/api.response");
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} = require("../utils/jwt.utils");
const { options } = require("../routes/auth.routes");

/**
 * @desc    User login
 * @route   POST /api/auth/login
 * @access  Public
 */
exports.login = asyncHandler(async (req, res) => {
  const { userID: userId, password } = req.body;
  console.log(userId, password);
  // Validate input
  if (!userId || !password) {
    throw ApiError.badRequest("userId and password required", {
      required: ["userId", "password"],
      provided: { userId: !!userId, password: !!password },
    });
  }

  // Find user by email
  const user = await User.findOne({ userId });
  if (!user) {
    throw ApiError.unauthorized("userId is not valid");
  }

  // Verify password
  const isPasswordValid = user.password === password;
  if (!isPasswordValid) {
    throw ApiError.unauthorized("Invalid password");
  }

  // Generate tokens
  const accessToken = generateAccessToken(user._id);

  await user.save({ validateBeforeSave: false });
  // Prepare user data for response
  const userData = {
    userId: user.userId,
    name: user.name,
    role: user.role,
    _id: user._id,
    createdAt: user.createdAt,
  };
  const response = ApiResponse.success("Login successful", {
    accessToken,
    user: userData,
  });

  res.status(response.statusCode).json(response);
});

/**
 * @desc    Refresh access token
 * @route   POST /api/auth/refresh
 * @access  Public
 */
exports.refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    throw ApiError.badRequest("Refresh token is required", {
      required: ["refreshToken"],
    });
  }

  try {
    const decoded = verifyRefreshToken(refreshToken);

    // Verify user still exists
    const user = await User.findById(decoded.id);
    if (!user) {
      throw ApiError.unauthorized("Secure token Expired");
    }

    const accessToken = generateAccessToken(decoded.id);
    const refreshToken = generateRefreshToken(decoded.id);
    const response = ApiResponse.success(
      "Access token refreshed successfully",
      {}
    );
    const options = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    };

    res
      .cookie("accessToken", accessToken, options)
      .cookie("refreshToken", refreshToken, options)
      .status(response.statusCode)
      .json(response);
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      throw ApiError.unauthorized("Refresh token has expired");
    }
    if (error.name === "JsonWebTokenError") {
      throw ApiError.unauthorized("Invalid refresh token");
    }
    throw ApiError.unauthorized("Invalid or expired refresh token");
  }
});

/**
 * @desc    User logout
 * @route   POST /api/auth/logout
 * @access  Private
 */
exports.logout = asyncHandler(async (req, res) => {
  // In a more advanced implementation, you might:
  // 1. Add the token to a blacklist
  // 2. Update user's last logout timestamp
  // 3. Clear session data

  const response = ApiResponse.success("Logged out successfully", {
    timestamp: new Date().toISOString(),
    message: "Please remove tokens from client storage",
  });

  res
    .cookie("accessToken", "", {
      expires: new Date(0), // Expire now
    })
    .status(response.statusCode)
    .json(response);
});
